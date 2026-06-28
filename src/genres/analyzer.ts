import { generateObject } from "ai";
import { createModel } from "../ai/provider.ts";
import { buildProviderOptions } from "../ai/provider-options.ts";
import { samplePromptText } from "../ai/prompts.ts";
import type { AiSettings } from "../settings.ts";
import {
  aiKnowledgeCandidateExtractionSchema,
  aiSegmentAnalysisSchema,
  aiSourceSynthesisSchema,
} from "./analysis-schema.ts";
import type {
  AiSegmentAnalysis,
  AiSourceSynthesis,
} from "./analysis-schema.ts";
import { createKnowledgeCandidate } from "./knowledge.ts";
import { loadGenre } from "./repository.ts";
import { loadGenreSource } from "./sources.ts";
import {
  genreAnalysisRunSchema,
  GENRE_SCHEMA_VERSION,
} from "./schema.ts";
import type { GenreAnalysisRun, GenreKnowledgeDocument, GenreSourceSegment } from "./schema.ts";
import {
  buildKnowledgeCandidateExtractionPrompt,
  buildSegmentAnalysisPrompt,
  buildSourceSynthesisPrompt,
  GENRE_ANALYSIS_PROMPT_VERSION,
} from "./prompts.ts";
import { extractSegmentContent } from "./segmentation.ts";
import { writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { genreAnalysesDir, genreSourcesDir } from "./repository.ts";
import { computeTextHash } from "./hash.ts";

const ANALYSIS_CONCURRENCY = 2;

export interface AnalysisProgressEvent {
  kind: "segmentation" | "segment" | "synthesis" | "candidates" | "complete" | "error";
  completedSegments?: number;
  totalSegments?: number;
  message?: string;
}

export type AnalysisProgressCallback = (event: AnalysisProgressEvent) => void;

interface MapWithConcurrencyOptions {
  abortSignal?: AbortSignal;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
  options: MapWithConcurrencyOptions = {},
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      if (options.abortSignal?.aborted) {
        throw new Error("Aborted");
      }
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  });

  await Promise.all(workers);
  return results;
}

function normalizeSettings(settings: AiSettings): AiSettings {
  return {
    ...settings,
    apiKey: settings.apiKey.trim(),
    baseUrl: settings.baseUrl.trim(),
    model: settings.model.trim(),
    temperature:
      typeof settings.temperature === "number" && settings.temperature >= 0 && settings.temperature <= 2
        ? settings.temperature
        : 0.3,
    maxTokens: typeof settings.maxTokens === "number" && settings.maxTokens > 0 ? settings.maxTokens : 8192,
    maxContextTokens:
      typeof settings.maxContextTokens === "number" && settings.maxContextTokens > 0
        ? settings.maxContextTokens
        : 65536,
  };
}

async function analyzeSegment(
  settings: AiSettings,
  genreName: string,
  sourceTitle: string,
  sourceRole: string,
  segment: GenreSourceSegment,
  segmentText: string,
  abortSignal?: AbortSignal,
): Promise<AiSegmentAnalysis> {
  const s = normalizeSettings(settings);
  const prompt = buildSegmentAnalysisPrompt(
    { name: genreName } as { name: string },
    sourceTitle,
    sourceRole,
    segment,
    segmentText,
  );

  const result = await generateObject({
    model: createModel(s),
    schema: aiSegmentAnalysisSchema,
    system: `You are a genre research assistant. Follow the schema exactly. Output all natural-language text in Japanese.`,
    prompt,
    maxOutputTokens: s.maxTokens,
    temperature: s.temperature,
    abortSignal,
    ...(buildProviderOptions(s, false) && { providerOptions: buildProviderOptions(s, false) }),
  });

  return result.object;
}

async function synthesizeSourceAnalysis(
  settings: AiSettings,
  genreName: string,
  sourceTitle: string,
  sourceRole: string,
  segmentAnalyses: AiSegmentAnalysis[],
  sampledSourceText: string,
  abortSignal?: AbortSignal,
): Promise<AiSourceSynthesis> {
  const s = normalizeSettings(settings);
  const prompt = buildSourceSynthesisPrompt(
    { name: genreName } as { name: string },
    sourceTitle,
    sourceRole,
    segmentAnalyses,
    sampledSourceText,
  );

  const result = await generateObject({
    model: createModel(s),
    schema: aiSourceSynthesisSchema,
    system: `You are a genre research assistant. Follow the schema exactly. Output all natural-language text in Japanese.`,
    prompt,
    maxOutputTokens: s.maxTokens,
    temperature: s.temperature,
    abortSignal,
    ...(buildProviderOptions(s, false) && { providerOptions: buildProviderOptions(s, false) }),
  });

  return result.object;
}

async function extractKnowledgeCandidates(
  settings: AiSettings,
  genreName: string,
  segmentAnalyses: AiSegmentAnalysis[],
  synthesis: AiSourceSynthesis,
  existingKnowledge: GenreKnowledgeDocument,
  abortSignal?: AbortSignal,
): ReturnType<typeof createKnowledgeCandidate>[] {
  const s = normalizeSettings(settings);
  const prompt = buildKnowledgeCandidateExtractionPrompt(
    { name: genreName } as { name: string },
    segmentAnalyses,
    synthesis,
    existingKnowledge,
  );

  const result = await generateObject({
    model: createModel(s),
    schema: aiKnowledgeCandidateExtractionSchema,
    system: `You are a genre research assistant. Follow the schema exactly. Output all natural-language text in Japanese.`,
    prompt,
    maxOutputTokens: s.maxTokens,
    temperature: s.temperature,
    abortSignal,
    ...(buildProviderOptions(s, false) && { providerOptions: buildProviderOptions(s, false) }),
  });

  const candidates = result.object.candidates.map((candidate) =>
    createKnowledgeCandidate(genreName, {
      category: candidate.category,
      title: candidate.title,
      statement: candidate.statement,
      explanation: candidate.explanation,
      proposedImportance: candidate.proposedImportance,
      confidence: candidate.confidence,
      origin: "source_analysis",
      sourceReferences: candidate.evidenceSegmentIds.map((segmentId) => ({
        sourceId: "",
        segmentId,
      })),
      chatReferences: [],
      createdBy: "ai",
    }),
  );

  return candidates;
}

function mapAiSegmentAnalysis(
  aiAnalysis: AiSegmentAnalysis,
  runId: string,
  sourceId: string,
  segment: GenreSourceSegment,
): import("./schema.ts").GenreSegmentAnalysis {
  const mapObservation = (
    observation: import("./analysis-schema.ts").AiSegmentAnalysis["proseFeatures"][number],
  ): import("./schema.ts").GenreFeatureObservation => ({
    id: crypto.randomUUID(),
    statement: observation.statement,
    explanation: observation.explanation,
    confidence: observation.confidence,
    evidence: observation.evidenceExcerpts.map((excerpt) => ({
      segmentId: segment.id,
      excerpt,
    })),
  });

  const mapScenePattern = (
    pattern: import("./analysis-schema.ts").AiSegmentAnalysis["scenePatterns"][number],
  ): import("./schema.ts").GenreScenePatternObservation => ({
    id: crypto.randomUUID(),
    name: pattern.name,
    purpose: pattern.purpose,
    prerequisites: pattern.prerequisites,
    progression: pattern.progression,
    expectedEffect: pattern.expectedEffect,
    avoid: pattern.avoid,
    confidence: pattern.confidence,
    evidenceSegmentIds: pattern.evidenceExcerpts.map(() => segment.id),
  });

  return {
    id: crypto.randomUUID(),
    analysisRunId: runId,
    sourceId,
    segmentId: segment.id,
    summary: aiAnalysis.summary,
    pointOfView: aiAnalysis.pointOfView,
    narratorCharacteristics: aiAnalysis.narratorCharacteristics,
    proseFeatures: aiAnalysis.proseFeatures.map(mapObservation),
    rhythmFeatures: aiAnalysis.rhythmFeatures.map(mapObservation),
    dialogueFeatures: aiAnalysis.dialogueFeatures.map(mapObservation),
    descriptionFeatures: aiAnalysis.descriptionFeatures.map(mapObservation),
    interiorityFeatures: aiAnalysis.interiorityFeatures.map(mapObservation),
    pacingFeatures: aiAnalysis.pacingFeatures.map(mapObservation),
    informationDisclosureFeatures: aiAnalysis.informationDisclosureFeatures.map(mapObservation),
    emotionalEffectFeatures: aiAnalysis.emotionalEffectFeatures.map(mapObservation),
    narrativeFunctions: aiAnalysis.narrativeFunctions.map(mapObservation),
    scenePatterns: aiAnalysis.scenePatterns.map(mapScenePattern),
    characterFunctions: aiAnalysis.characterFunctions.map(mapObservation),
    worldbuildingFunctions: aiAnalysis.worldbuildingFunctions.map(mapObservation),
    genreSignals: aiAnalysis.genreSignals.map(mapObservation),
    nonGenreSignals: aiAnalysis.nonGenreSignals.map(mapObservation),
    workSpecificFeatures: aiAnalysis.workSpecificFeatures.map(mapObservation),
    possibleFailureModes: aiAnalysis.possibleFailureModes.map(mapObservation),
    generationGuidance: aiAnalysis.generationGuidance.map(mapObservation),
    confidence: aiAnalysis.overallConfidence,
  };
}

export async function analyzeSource(
  genreId: string,
  sourceId: string,
  settings: AiSettings,
  progressCallback?: AnalysisProgressCallback,
  abortSignal?: AbortSignal,
): Promise<GenreAnalysisRun> {
  progressCallback?.({ kind: "segmentation", message: "セグメント情報を読み込んでいます..." });

  const genre = await loadGenre(genreId);
  const { metadata: source, content, segments } = await loadGenreSource(genreId, sourceId);
  const runId = crypto.randomUUID();
  const now = new Date().toISOString();

  const run: GenreAnalysisRun = {
    id: runId,
    genreId,
    sourceId,
    status: "running",
    sourceHash: source.contentHash,
    promptVersion: GENRE_ANALYSIS_PROMPT_VERSION,
    provider: settings.provider,
    model: settings.model,
    totalSegments: segments.length,
    completedSegments: 0,
    failedSegments: 0,
    segmentResults: [],
    startedAt: now,
  };

  await saveAnalysisRun(genreId, run);

  try {
    progressCallback?.({
      kind: "segment",
      completedSegments: 0,
      totalSegments: segments.length,
      message: "セグメントを分析しています...",
    });

    const segmentResults: import("./schema.ts").GenreSegmentAnalysis[] = [];

    await mapWithConcurrency(
      segments,
      ANALYSIS_CONCURRENCY,
      async (segment, index) => {
        if (abortSignal?.aborted) {
          throw new Error("Aborted");
        }

        const segmentText = extractSegmentContent(content, segment);
        try {
          const aiAnalysis = await analyzeSegment(
            settings,
            genre.name,
            source.title,
            source.sourceRole,
            segment,
            segmentText,
            abortSignal,
          );
          const mapped = mapAiSegmentAnalysis(aiAnalysis, runId, sourceId, segment);
          segmentResults.push(mapped);
          run.completedSegments += 1;
        } catch (error) {
          run.failedSegments += 1;
          console.error(`[phenex:genres] segment ${index} analysis failed:`, error);
        }

        progressCallback?.({
          kind: "segment",
          completedSegments: run.completedSegments,
          totalSegments: segments.length,
          message: `セグメントを分析中 (${run.completedSegments + run.failedSegments}/${segments.length})...`,
        });
      },
      { abortSignal },
    );

    run.segmentResults = segmentResults;

    progressCallback?.({ kind: "synthesis", message: "資料全体を統合分析しています..." });

    const sampledSourceText = samplePromptText(content, 4000, 3);
    const aiSynthesis = await synthesizeSourceAnalysis(
      settings,
      genre.name,
      source.title,
      source.sourceRole,
      segmentResults.map((r) => ({
        summary: r.summary,
        pointOfView: r.pointOfView,
        narratorCharacteristics: r.narratorCharacteristics,
        proseFeatures: r.proseFeatures.map((f) => ({
          statement: f.statement,
          explanation: f.explanation,
          confidence: f.confidence,
          evidenceExcerpts: f.evidence.map((e) => e.excerpt ?? "").filter(Boolean),
        })),
        rhythmFeatures: r.rhythmFeatures.map((f) => ({
          statement: f.statement,
          explanation: f.explanation,
          confidence: f.confidence,
          evidenceExcerpts: f.evidence.map((e) => e.excerpt ?? "").filter(Boolean),
        })),
        dialogueFeatures: r.dialogueFeatures.map((f) => ({
          statement: f.statement,
          explanation: f.explanation,
          confidence: f.confidence,
          evidenceExcerpts: f.evidence.map((e) => e.excerpt ?? "").filter(Boolean),
        })),
        descriptionFeatures: r.descriptionFeatures.map((f) => ({
          statement: f.statement,
          explanation: f.explanation,
          confidence: f.confidence,
          evidenceExcerpts: f.evidence.map((e) => e.excerpt ?? "").filter(Boolean),
        })),
        interiorityFeatures: r.interiorityFeatures.map((f) => ({
          statement: f.statement,
          explanation: f.explanation,
          confidence: f.confidence,
          evidenceExcerpts: f.evidence.map((e) => e.excerpt ?? "").filter(Boolean),
        })),
        pacingFeatures: r.pacingFeatures.map((f) => ({
          statement: f.statement,
          explanation: f.explanation,
          confidence: f.confidence,
          evidenceExcerpts: f.evidence.map((e) => e.excerpt ?? "").filter(Boolean),
        })),
        informationDisclosureFeatures: r.informationDisclosureFeatures.map((f) => ({
          statement: f.statement,
          explanation: f.explanation,
          confidence: f.confidence,
          evidenceExcerpts: f.evidence.map((e) => e.excerpt ?? "").filter(Boolean),
        })),
        emotionalEffectFeatures: r.emotionalEffectFeatures.map((f) => ({
          statement: f.statement,
          explanation: f.explanation,
          confidence: f.confidence,
          evidenceExcerpts: f.evidence.map((e) => e.excerpt ?? "").filter(Boolean),
        })),
        narrativeFunctions: r.narrativeFunctions.map((f) => ({
          statement: f.statement,
          explanation: f.explanation,
          confidence: f.confidence,
          evidenceExcerpts: f.evidence.map((e) => e.excerpt ?? "").filter(Boolean),
        })),
        scenePatterns: r.scenePatterns.map((p) => ({
          name: p.name,
          purpose: p.purpose,
          prerequisites: p.prerequisites,
          progression: p.progression,
          expectedEffect: p.expectedEffect,
          avoid: p.avoid,
          confidence: p.confidence,
          evidenceExcerpts: [],
        })),
        characterFunctions: r.characterFunctions.map((f) => ({
          statement: f.statement,
          explanation: f.explanation,
          confidence: f.confidence,
          evidenceExcerpts: f.evidence.map((e) => e.excerpt ?? "").filter(Boolean),
        })),
        worldbuildingFunctions: r.worldbuildingFunctions.map((f) => ({
          statement: f.statement,
          explanation: f.explanation,
          confidence: f.confidence,
          evidenceExcerpts: f.evidence.map((e) => e.excerpt ?? "").filter(Boolean),
        })),
        genreSignals: r.genreSignals.map((f) => ({
          statement: f.statement,
          explanation: f.explanation,
          confidence: f.confidence,
          evidenceExcerpts: f.evidence.map((e) => e.excerpt ?? "").filter(Boolean),
        })),
        nonGenreSignals: r.nonGenreSignals.map((f) => ({
          statement: f.statement,
          explanation: f.explanation,
          confidence: f.confidence,
          evidenceExcerpts: f.evidence.map((e) => e.excerpt ?? "").filter(Boolean),
        })),
        workSpecificFeatures: r.workSpecificFeatures.map((f) => ({
          statement: f.statement,
          explanation: f.explanation,
          confidence: f.confidence,
          evidenceExcerpts: f.evidence.map((e) => e.excerpt ?? "").filter(Boolean),
        })),
        possibleFailureModes: r.possibleFailureModes.map((f) => ({
          statement: f.statement,
          explanation: f.explanation,
          confidence: f.confidence,
          evidenceExcerpts: f.evidence.map((e) => e.excerpt ?? "").filter(Boolean),
        })),
        generationGuidance: r.generationGuidance.map((f) => ({
          statement: f.statement,
          explanation: f.explanation,
          confidence: f.confidence,
          evidenceExcerpts: f.evidence.map((e) => e.excerpt ?? "").filter(Boolean),
        })),
        overallConfidence: r.confidence,
      })),
      sampledSourceText,
      abortSignal,
    );

    run.synthesis = {
      sourceSummary: aiSynthesis.sourceSummary,
      contributionToGenre: aiSynthesis.contributionToGenre,
      deviationsFromGenre: aiSynthesis.deviationsFromGenre,
      workSpecificElements: aiSynthesis.workSpecificElements,
      readerExpectations: aiSynthesis.readerExpectations,
      structuralPatterns: aiSynthesis.structuralPatterns,
      stylisticPatterns: aiSynthesis.stylisticPatterns,
      failureRisks: aiSynthesis.failureRisks,
    };

    progressCallback?.({ kind: "candidates", message: "知識候補を抽出しています..." });

    const { loadGenreKnowledge } = await import("./knowledge.ts");
    const existingKnowledge = await loadGenreKnowledge(genreId);
    const candidatePromises = await extractKnowledgeCandidates(
      settings,
      genre.name,
      run.segmentResults,
      run.synthesis,
      existingKnowledge,
      abortSignal,
    );

    const createdCandidates = await Promise.all(candidatePromises);
    for (const candidate of createdCandidates) {
      candidate.sourceReferences = candidate.sourceReferences.map((ref) => ({
        ...ref,
        sourceId,
        analysisRunId: runId,
      }));
    }

    run.status = "completed";
    run.completedAt = new Date().toISOString();
    await saveAnalysisRun(genreId, run);

    progressCallback?.({ kind: "complete", message: "分析が完了しました。" });
    return run;
  } catch (error) {
    run.status = abortSignal?.aborted ? "cancelled" : "failed";
    run.error = error instanceof Error ? error.message : String(error);
    run.completedAt = new Date().toISOString();
    await saveAnalysisRun(genreId, run);
    progressCallback?.({ kind: "error", message: run.error });
    throw error;
  }
}

async function saveAnalysisRun(genreId: string, run: GenreAnalysisRun): Promise<void> {
  const listText = await readTextFile(`${genreAnalysesDir(genreId)}/index.json`, {
    baseDir: BaseDirectory.Document,
  }).catch(() => JSON.stringify({ schemaVersion: GENRE_SCHEMA_VERSION, runs: [] }));
  const parsed: unknown = JSON.parse(listText);
  const runs: GenreAnalysisRun[] =
    typeof parsed === "object" && parsed !== null && "runs" in parsed && Array.isArray(parsed.runs)
      ? (parsed.runs as GenreAnalysisRun[])
      : [];

  const existingIndex = runs.findIndex((r) => r.id === run.id);
  if (existingIndex >= 0) {
    runs[existingIndex] = run;
  } else {
    runs.push(run);
  }

  await writeTextFile(
    `${genreAnalysesDir(genreId)}/index.json`,
    JSON.stringify({ schemaVersion: GENRE_SCHEMA_VERSION, runs }, null, 2),
    { baseDir: BaseDirectory.Document },
  );

  const validated = genreAnalysisRunSchema.parse(run);
  await writeTextFile(
    `${genreAnalysesDir(genreId)}/${run.id}.json`,
    JSON.stringify(validated, null, 2),
    { baseDir: BaseDirectory.Document },
  );
}

export async function listAnalysisRuns(genreId: string): Promise<GenreAnalysisRun[]> {
  try {
    const text = await readTextFile(`${genreAnalysesDir(genreId)}/index.json`, {
      baseDir: BaseDirectory.Document,
    });
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "runs" in parsed &&
      Array.isArray(parsed.runs)
    ) {
      return parsed.runs as GenreAnalysisRun[];
    }
  } catch {
    // ignore
  }
  return [];
}

export async function loadAnalysisRun(
  genreId: string,
  analysisRunId: string,
): Promise<GenreAnalysisRun | undefined> {
  try {
    const text = await readTextFile(`${genreAnalysesDir(genreId)}/${analysisRunId}.json`, {
      baseDir: BaseDirectory.Document,
    });
    const parsed: unknown = JSON.parse(text);
    const result = genreAnalysisRunSchema.safeParse(parsed);
    if (result.success) return result.data;
  } catch {
    // ignore
  }
  return undefined;
}
