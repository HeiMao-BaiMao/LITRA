import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { limitPromptText } from "../ai/prompts.ts";
import { aiChatConclusionExtractionSchema } from "./analysis-schema.ts";
import type { GenreChatDocument, GenreKnowledgeDocument } from "./schema.ts";
import { buildChatConclusionExtractionPrompt, buildChatCandidateFromMessagePrompt } from "./prompts.ts";
import { createKnowledgeCandidate } from "./knowledge.ts";
import { listGenreSources, loadGenreSource } from "./sources.ts";
import { loadAnalysisRun, listAnalysisRuns } from "./analyzer.ts";
import { loadGenreKnowledge } from "./knowledge.ts";
import { loadGenreChatThread } from "./chat.ts";
import { buildChatMessagesText } from "./chat-context.ts";
import { extractSegmentContent } from "./segmentation.ts";
import { generateObject } from "ai";
import { createModel } from "../ai/provider.ts";
import { buildProviderOptions } from "../ai/provider-options.ts";
import type { AiSettings } from "../settings.ts";

export interface GenreChatToolDependencies {
  genreId: string;
  settings: AiSettings;
  threadId?: string;
}

const SOURCE_SNIPPET_MAX_CHARS = 3000;
const KNOWLEDGE_SNIPPET_MAX_CHARS = 1500;

function wrapToolExecute<TInput, TOutput>(
  name: string,
  execute: (input: TInput) => Promise<TOutput>,
): (input: TInput) => Promise<TOutput | { error: string }> {
  return async (input) => {
    try {
      return await execute(input);
    } catch (error) {
      console.error(`[phenex:genres] tool ${name} error:`, error);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  };
}

function createListGenreSourcesTool(deps: GenreChatToolDependencies) {
  return tool({
    description: "Lists all reference sources registered for the current genre.",
    inputSchema: z.object({}),
    execute: wrapToolExecute("listGenreSources", async () => {
      const sources = await listGenreSources(deps.genreId);
      return {
        sources: sources.map((source) => ({
          id: source.id,
          title: source.title,
          sourceType: source.sourceType,
          sourceRole: source.sourceRole,
          analysisStatus: source.analysisStatus,
        })),
      };
    }),
  });
}

function createReadGenreSourceMetadataTool(deps: GenreChatToolDependencies) {
  return tool({
    description: "Reads metadata for a specific genre reference source.",
    inputSchema: z.object({
      sourceId: z.string().describe("The source ID."),
    }),
    execute: wrapToolExecute("readGenreSourceMetadata", async ({ sourceId }) => {
      const sources = await listGenreSources(deps.genreId);
      const source = sources.find((s) => s.id === sourceId);
      if (!source) return { error: "Source not found." };
      return { source };
    }),
  });
}

function createReadGenreSourceSegmentTool(deps: GenreChatToolDependencies) {
  return tool({
    description: "Reads a specific segment from a genre reference source.",
    inputSchema: z.object({
      sourceId: z.string(),
      segmentId: z.string(),
    }),
    execute: wrapToolExecute("readGenreSourceSegment", async ({ sourceId, segmentId }) => {
      const { content, segments } = await loadGenreSource(deps.genreId, sourceId);
      const segment = segments.find((s) => s.id === segmentId);
      if (!segment) return { error: "Segment not found." };
      const segmentText = extractSegmentContent(content, segment);
      return {
        segment: {
          ...segment,
          content: limitPromptText(segmentText, SOURCE_SNIPPET_MAX_CHARS, "middle"),
        },
      };
    }),
  });
}

function createSearchGenreSourceTextTool(deps: GenreChatToolDependencies) {
  return tool({
    description:
      "Searches for a query phrase within the registered genre reference sources and returns matching source IDs with short snippets.",
    inputSchema: z.object({
      query: z.string(),
      sourceIds: z.array(z.string()).optional(),
      maxResults: z.number().int().min(1).max(20).optional(),
    }),
    execute: wrapToolExecute("searchGenreSourceText", async ({ query, sourceIds, maxResults }) => {
      const sources = await listGenreSources(deps.genreId);
      const targetSources = sourceIds?.length
        ? sources.filter((s) => sourceIds.includes(s.id))
        : sources;

      const results: Array<{ sourceId: string; title: string; snippet: string }> = [];
      const limit = maxResults ?? 10;
      const normalizedQuery = query.toLowerCase();

      for (const source of targetSources) {
        if (results.length >= limit) break;
        try {
          const { content, segments } = await loadGenreSource(deps.genreId, source.id);
          for (const segment of segments) {
            const segmentText = extractSegmentContent(content, segment);
            if (segmentText.toLowerCase().includes(normalizedQuery)) {
              const index = segmentText.toLowerCase().indexOf(normalizedQuery);
              const start = Math.max(0, index - 80);
              const end = Math.min(segmentText.length, index + query.length + 80);
              results.push({
                sourceId: source.id,
                title: source.title,
                snippet: limitPromptText(segmentText.slice(start, end), 300, "middle"),
              });
              if (results.length >= limit) break;
            }
          }
        } catch (error) {
          console.warn(`[phenex:genres] search source ${source.id} failed:`, error);
        }
      }

      return { results };
    }),
  });
}

function createListGenreAnalysesTool(deps: GenreChatToolDependencies) {
  return tool({
    description: "Lists analysis runs for the current genre's reference sources.",
    inputSchema: z.object({
      sourceId: z.string().optional(),
    }),
    execute: wrapToolExecute("listGenreAnalyses", async ({ sourceId }) => {
      const runs = await listAnalysisRuns(deps.genreId);
      const filtered = sourceId ? runs.filter((run) => run.sourceId === sourceId) : runs;
      return {
        runs: filtered.map((run) => ({
          id: run.id,
          sourceId: run.sourceId,
          status: run.status,
          model: run.model,
          completedSegments: run.completedSegments,
          totalSegments: run.totalSegments,
        })),
      };
    }),
  });
}

function createReadGenreAnalysisTool(deps: GenreChatToolDependencies) {
  return tool({
    description: "Reads a specific analysis run summary.",
    inputSchema: z.object({
      analysisRunId: z.string(),
    }),
    execute: wrapToolExecute("readGenreAnalysis", async ({ analysisRunId }) => {
      const run = await loadAnalysisRun(deps.genreId, analysisRunId);
      if (!run) return { error: "Analysis run not found." };
      return {
        run: {
          ...run,
          segmentResults: run.segmentResults.map((segment) => ({
            ...segment,
            proseFeatures: segment.proseFeatures.slice(0, 5),
            scenePatterns: segment.scenePatterns.slice(0, 3),
          })),
        },
      };
    }),
  });
}

function createListGenreKnowledgeTool(deps: GenreChatToolDependencies) {
  return tool({
    description: "Lists accepted knowledge items for the current genre.",
    inputSchema: z.object({
      category: z.string().optional(),
    }),
    execute: wrapToolExecute("listGenreKnowledge", async ({ category }) => {
      const knowledge = await loadGenreKnowledge(deps.genreId);
      const items = category
        ? knowledge.items.filter((item) => item.status === "active" && item.category === category)
        : knowledge.items.filter((item) => item.status === "active");
      return {
        items: items.map((item) => ({
          id: item.id,
          category: item.category,
          title: item.title,
          statement: limitPromptText(item.statement, KNOWLEDGE_SNIPPET_MAX_CHARS, "head"),
          importance: item.importance,
        })),
      };
    }),
  });
}

function createReadGenreKnowledgeItemTool(deps: GenreChatToolDependencies) {
  return tool({
    description: "Reads a specific accepted knowledge item.",
    inputSchema: z.object({
      itemId: z.string(),
    }),
    execute: wrapToolExecute("readGenreKnowledgeItem", async ({ itemId }) => {
      const knowledge = await loadGenreKnowledge(deps.genreId);
      const item = knowledge.items.find((i) => i.id === itemId);
      if (!item) return { error: "Knowledge item not found." };
      return { item };
    }),
  });
}

function createListGenreKnowledgeCandidatesTool(deps: GenreChatToolDependencies) {
  return tool({
    description: "Lists pending knowledge candidates for the current genre.",
    inputSchema: z.object({}),
    execute: wrapToolExecute("listGenreKnowledgeCandidates", async () => {
      const knowledge = await loadGenreKnowledge(deps.genreId);
      const candidates = knowledge.candidates.filter((c) => c.status === "pending");
      return {
        candidates: candidates.map((c) => ({
          id: c.id,
          category: c.category,
          title: c.title,
          statement: limitPromptText(c.statement, KNOWLEDGE_SNIPPET_MAX_CHARS, "head"),
          proposedImportance: c.proposedImportance,
          confidence: c.confidence,
        })),
      };
    }),
  });
}

function createProposeGenreKnowledgeItemTool(deps: GenreChatToolDependencies) {
  return tool({
    description:
      "Proposes a new genre knowledge candidate. This does not finalize the knowledge; the user must review and accept it.",
    inputSchema: z.object({
      category: z.enum([
        "definition",
        "core_requirement",
        "frequent_feature",
        "optional_feature",
        "boundary_condition",
        "genre_differentiator",
        "prose_style",
        "narrative_structure",
        "scene_pattern",
        "character_function",
        "worldbuilding_function",
        "reader_contract",
        "emotional_effect",
        "generation_guidance",
        "prohibition",
        "failure_mode",
        "evaluation_criterion",
      ]),
      title: z.string(),
      statement: z.string(),
      explanation: z.string(),
      proposedImportance: z.enum(["core", "frequent", "optional", "boundary", "work_specific"]),
      sourceSegmentIds: z.array(z.string()).optional(),
    }),
    execute: wrapToolExecute("proposeGenreKnowledgeItem", async (input) => {
      const candidate = await createKnowledgeCandidate(deps.genreId, {
        category: input.category,
        title: input.title,
        statement: input.statement,
        explanation: input.explanation,
        proposedImportance: input.proposedImportance,
        confidence: 0.7,
        origin: "genre_chat",
        sourceReferences:
          input.sourceSegmentIds?.map((segmentId) => ({
            sourceId: "",
            segmentId,
          })) ?? [],
        chatReferences: deps.threadId
          ? [
              {
                threadId: deps.threadId,
                messageIds: [],
              },
            ]
          : [],
        createdBy: "ai",
      });
      return {
        success: true,
        candidateId: candidate.id,
        message: "知識候補を作成しました。採用するにはレビュー画面で承認してください。",
      };
    }),
  });
}

function createProposeGenreKnowledgeUpdateTool(deps: GenreChatToolDependencies) {
  return tool({
    description:
      "Proposes an update to an existing accepted knowledge item. This does not apply the change; the user must review and accept it.",
    inputSchema: z.object({
      targetKnowledgeItemId: z.string(),
      proposedStatement: z.string(),
      reason: z.string(),
    }),
    execute: wrapToolExecute("proposeGenreKnowledgeUpdate", async (input) => {
      const knowledge = await loadGenreKnowledge(deps.genreId);
      const item = knowledge.items.find((i) => i.id === input.targetKnowledgeItemId);
      if (!item) return { error: "Target knowledge item not found." };

      const candidate = await createKnowledgeCandidate(deps.genreId, {
        category: item.category,
        title: `${item.title}（修正案）`,
        statement: input.proposedStatement,
        explanation: `【修正理由】\n${input.reason}\n\n【元の文面】\n${item.statement}`,
        proposedImportance: item.importance === "work_specific" ? "optional" : item.importance,
        confidence: 0.6,
        origin: "genre_chat",
        sourceReferences: [],
        chatReferences: deps.threadId
          ? [
              {
                threadId: deps.threadId,
                messageIds: [],
              },
            ]
          : [],
        createdBy: "ai",
      });

      return {
        success: true,
        candidateId: candidate.id,
        message: "修正候補を作成しました。採用するにはレビュー画面で承認してください。",
      };
    }),
  });
}

function createProposeGenreKnowledgeDisableTool(deps: GenreChatToolDependencies) {
  return tool({
    description:
      "Proposes disabling an existing accepted knowledge item. This does not apply the change; the user must review and accept it.",
    inputSchema: z.object({
      targetKnowledgeItemId: z.string(),
      reason: z.string(),
    }),
    execute: wrapToolExecute("proposeGenreKnowledgeDisable", async (input) => {
      const knowledge = await loadGenreKnowledge(deps.genreId);
      const item = knowledge.items.find((i) => i.id === input.targetKnowledgeItemId);
      if (!item) return { error: "Target knowledge item not found." };

      const candidate = await createKnowledgeCandidate(deps.genreId, {
        category: "failure_mode",
        title: `${item.title}（無効化提案）`,
        statement: `既存知識「${item.title}」を無効化する提案`,
        explanation: `【無効化理由】\n${input.reason}`,
        proposedImportance: "boundary",
        confidence: 0.5,
        origin: "genre_chat",
        sourceReferences: [],
        chatReferences: deps.threadId
          ? [
              {
                threadId: deps.threadId,
                messageIds: [],
              },
            ]
          : [],
        createdBy: "ai",
      });

      return {
        success: true,
        candidateId: candidate.id,
        message: "無効化候補を作成しました。採用するにはレビュー画面で承認してください。",
      };
    }),
  });
}

function createProposeThreadSummaryTool(deps: GenreChatToolDependencies) {
  return tool({
    description:
      "Proposes a summary of the current chat thread. This does not overwrite the thread summary; the user must review and accept it.",
    inputSchema: z.object({
      summary: z.string(),
    }),
    execute: wrapToolExecute("proposeThreadSummary", async (input) => {
      return {
        success: true,
        proposedSummary: input.summary,
        message: "スレッド要約案を作成しました。",
      };
    }),
  });
}

function createProposeChatConclusionsTool(deps: GenreChatToolDependencies) {
  return tool({
    description:
      "Extracts agreed conclusions from the current chat thread and proposes knowledge candidates. This does not finalize anything.",
    inputSchema: z.object({}),
    execute: wrapToolExecute("proposeChatConclusions", async () => {
      if (!deps.threadId) return { error: "No active thread." };

      const thread = await loadGenreChatThread(deps.genreId, deps.threadId);
      const knowledge = await loadGenreKnowledge(deps.genreId);
      const messagesText = buildChatMessagesText(thread.messages);
      const prompt = buildChatConclusionExtractionPrompt(
        { name: "" } as { name: string },
        thread.thread.title,
        messagesText,
        knowledge,
      );

      const s = deps.settings;
      const result = await generateObject({
        model: createModel(s),
        schema: aiChatConclusionExtractionSchema,
        system: "You are a genre research assistant. Extract proposed conclusions only. Output in Japanese.",
        prompt,
        maxOutputTokens: s.maxTokens ?? 8192,
        temperature: 0.3,
        ...(buildProviderOptions(s, false) && { providerOptions: buildProviderOptions(s, false) }),
      });

      const candidates = await Promise.all(
        result.object.newKnowledgeCandidates.map((candidate) =>
          createKnowledgeCandidate(deps.genreId, {
            category: candidate.category,
            title: candidate.title,
            statement: candidate.statement,
            explanation: candidate.explanation,
            proposedImportance: candidate.proposedImportance,
            confidence: 0.6,
            origin: "genre_chat",
            sourceReferences: [],
            chatReferences: deps.threadId
              ? [
                  {
                    threadId: deps.threadId,
                    messageIds: thread.messages.map((m) => m.id),
                  },
                ]
              : [],
            createdBy: "ai",
          }),
        ),
      );

      return {
        success: true,
        newCandidateIds: candidates.map((c) => c.id),
        updateProposals: result.object.updateCandidates,
        contradictions: result.object.contradictions,
        unresolvedQuestions: result.object.unresolvedQuestions,
      };
    }),
  });
}

export function createGenreChatTools(deps: GenreChatToolDependencies): ToolSet {
  return {
    listGenreSources: createListGenreSourcesTool(deps),
    readGenreSourceMetadata: createReadGenreSourceMetadataTool(deps),
    readGenreSourceSegment: createReadGenreSourceSegmentTool(deps),
    searchGenreSourceText: createSearchGenreSourceTextTool(deps),
    listGenreAnalyses: createListGenreAnalysesTool(deps),
    readGenreAnalysis: createReadGenreAnalysisTool(deps),
    listGenreKnowledge: createListGenreKnowledgeTool(deps),
    readGenreKnowledgeItem: createReadGenreKnowledgeItemTool(deps),
    listGenreKnowledgeCandidates: createListGenreKnowledgeCandidatesTool(deps),
    proposeGenreKnowledgeItem: createProposeGenreKnowledgeItemTool(deps),
    proposeGenreKnowledgeUpdate: createProposeGenreKnowledgeUpdateTool(deps),
    proposeGenreKnowledgeDisable: createProposeGenreKnowledgeDisableTool(deps),
    proposeThreadSummary: createProposeThreadSummaryTool(deps),
    proposeChatConclusions: createProposeChatConclusionsTool(deps),
  };
}
