import { z } from "zod";

// ============================================================================
// Genre
// ============================================================================

export const GENRE_SCHEMA_VERSION = 1;

export interface Genre {
  schemaVersion: typeof GENRE_SCHEMA_VERSION;
  id: string;
  name: string;
  aliases: string[];
  description: string;
  userDefinition: string;
  notes: string;
  tags: string[];
  status: "active" | "archived";
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export const genreSchema = z.object({
  schemaVersion: z.literal(GENRE_SCHEMA_VERSION),
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  description: z.string(),
  userDefinition: z.string(),
  notes: z.string(),
  tags: z.array(z.string()),
  status: z.enum(["active", "archived"]),
  revision: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export function isGenre(value: unknown): value is Genre {
  const result = genreSchema.safeParse(value);
  return result.success;
}

// ============================================================================
// GenreIndex
// ============================================================================

export interface GenreIndexEntry {
  id: string;
  name: string;
  description: string;
  status: "active" | "archived";
  revision: number;
  sourceCount: number;
  acceptedKnowledgeCount: number;
  candidateKnowledgeCount: number;
  chatThreadCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface GenreIndex {
  schemaVersion: typeof GENRE_SCHEMA_VERSION;
  genres: GenreIndexEntry[];
}

export const genreIndexEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.enum(["active", "archived"]),
  revision: z.number().int().min(0),
  sourceCount: z.number().int().min(0),
  acceptedKnowledgeCount: z.number().int().min(0),
  candidateKnowledgeCount: z.number().int().min(0),
  chatThreadCount: z.number().int().min(0),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const genreIndexSchema = z.object({
  schemaVersion: z.literal(GENRE_SCHEMA_VERSION),
  genres: z.array(genreIndexEntrySchema),
});

export function isGenreIndex(value: unknown): value is GenreIndex {
  return genreIndexSchema.safeParse(value).success;
}

// ============================================================================
// GenreSource
// ============================================================================

export type GenreSourceType =
  | "fiction"
  | "fiction_excerpt"
  | "critical_essay"
  | "genre_explanation"
  | "user_note"
  | "other";

export type GenreSourceRole =
  | "core_example"
  | "partial_example"
  | "boundary_example"
  | "counterexample"
  | "historical_reference"
  | "critical_reference"
  | "user_interpretation";

export type GenreSourcePreference =
  | "positive"
  | "negative"
  | "neutral"
  | "not_applicable";

export type GenreAnalysisStatus =
  | "not_analyzed"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "stale";

export interface GenreSource {
  id: string;
  genreId: string;
  title: string;
  author: string;
  sourceType: GenreSourceType;
  sourceRole: GenreSourceRole;
  preference: GenreSourcePreference;
  sourceNote: string;
  userInterpretation: string;
  originalFileName?: string;
  mediaType: "text/plain" | "text/markdown";
  language: string;
  contentFileName: string;
  contentHash: string;
  characterCount: number;
  segmentCount: number;
  analysisStatus: GenreAnalysisStatus;
  latestAnalysisRunId?: string;
  createdAt: string;
  updatedAt: string;
}

export const genreSourceTypeSchema = z.enum([
  "fiction",
  "fiction_excerpt",
  "critical_essay",
  "genre_explanation",
  "user_note",
  "other",
]);

export const genreSourceRoleSchema = z.enum([
  "core_example",
  "partial_example",
  "boundary_example",
  "counterexample",
  "historical_reference",
  "critical_reference",
  "user_interpretation",
]);

export const genreSourcePreferenceSchema = z.enum([
  "positive",
  "negative",
  "neutral",
  "not_applicable",
]);

export const genreAnalysisStatusSchema = z.enum([
  "not_analyzed",
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
  "stale",
]);

export const genreSourceSchema = z.object({
  id: z.string(),
  genreId: z.string(),
  title: z.string(),
  author: z.string(),
  sourceType: genreSourceTypeSchema,
  sourceRole: genreSourceRoleSchema,
  preference: genreSourcePreferenceSchema,
  sourceNote: z.string(),
  userInterpretation: z.string(),
  originalFileName: z.string().optional(),
  mediaType: z.enum(["text/plain", "text/markdown"]),
  language: z.string(),
  contentFileName: z.string(),
  contentHash: z.string(),
  characterCount: z.number().int().min(0),
  segmentCount: z.number().int().min(0),
  analysisStatus: genreAnalysisStatusSchema,
  latestAnalysisRunId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export function isGenreSource(value: unknown): value is GenreSource {
  return genreSourceSchema.safeParse(value).success;
}

export interface GenreSourceListDocument {
  schemaVersion: typeof GENRE_SCHEMA_VERSION;
  sources: GenreSource[];
}

export const genreSourceListDocumentSchema = z.object({
  schemaVersion: z.literal(GENRE_SCHEMA_VERSION),
  sources: z.array(genreSourceSchema),
});

// ============================================================================
// GenreSourceSegment
// ============================================================================

export interface GenreSourceSegment {
  id: string;
  sourceId: string;
  ordinal: number;
  heading: string;
  startOffset: number;
  endOffset: number;
  contentHash: string;
  segmentationMethod:
    | "heading"
    | "scene_break"
    | "paragraph_group"
    | "fixed_length"
    | "manual";
}

export const genreSourceSegmentSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  ordinal: z.number().int().min(0),
  heading: z.string(),
  startOffset: z.number().int().min(0),
  endOffset: z.number().int().min(0),
  contentHash: z.string(),
  segmentationMethod: z.enum([
    "heading",
    "scene_break",
    "paragraph_group",
    "fixed_length",
    "manual",
  ]),
});

export interface GenreSourceSegmentDocument {
  schemaVersion: typeof GENRE_SCHEMA_VERSION;
  sourceId: string;
  segments: GenreSourceSegment[];
}

export const genreSourceSegmentDocumentSchema = z.object({
  schemaVersion: z.literal(GENRE_SCHEMA_VERSION),
  sourceId: z.string(),
  segments: z.array(genreSourceSegmentSchema),
});

// ============================================================================
// Analysis
// ============================================================================

export interface GenreFeatureObservation {
  id: string;
  statement: string;
  explanation: string;
  confidence: number;
  evidence: Array<{
    segmentId: string;
    excerpt?: string;
  }>;
}

export const genreFeatureObservationSchema = z.object({
  id: z.string(),
  statement: z.string(),
  explanation: z.string(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(
    z.object({
      segmentId: z.string(),
      excerpt: z.string().optional(),
    }),
  ),
});

export interface GenreScenePatternObservation {
  id: string;
  name: string;
  purpose: string;
  prerequisites: string[];
  progression: string[];
  expectedEffect: string;
  avoid: string[];
  confidence: number;
  evidenceSegmentIds: string[];
}

export const genreScenePatternObservationSchema = z.object({
  id: z.string(),
  name: z.string(),
  purpose: z.string(),
  prerequisites: z.array(z.string()),
  progression: z.array(z.string()),
  expectedEffect: z.string(),
  avoid: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  evidenceSegmentIds: z.array(z.string()),
});

export interface GenreSegmentAnalysis {
  id: string;
  analysisRunId: string;
  sourceId: string;
  segmentId: string;
  summary: string;
  pointOfView: string[];
  narratorCharacteristics: string[];
  proseFeatures: GenreFeatureObservation[];
  rhythmFeatures: GenreFeatureObservation[];
  dialogueFeatures: GenreFeatureObservation[];
  descriptionFeatures: GenreFeatureObservation[];
  interiorityFeatures: GenreFeatureObservation[];
  pacingFeatures: GenreFeatureObservation[];
  informationDisclosureFeatures: GenreFeatureObservation[];
  emotionalEffectFeatures: GenreFeatureObservation[];
  narrativeFunctions: GenreFeatureObservation[];
  scenePatterns: GenreScenePatternObservation[];
  characterFunctions: GenreFeatureObservation[];
  worldbuildingFunctions: GenreFeatureObservation[];
  genreSignals: GenreFeatureObservation[];
  nonGenreSignals: GenreFeatureObservation[];
  workSpecificFeatures: GenreFeatureObservation[];
  possibleFailureModes: GenreFeatureObservation[];
  generationGuidance: GenreFeatureObservation[];
  confidence: number;
}

export const genreSegmentAnalysisSchema = z.object({
  id: z.string(),
  analysisRunId: z.string(),
  sourceId: z.string(),
  segmentId: z.string(),
  summary: z.string(),
  pointOfView: z.array(z.string()),
  narratorCharacteristics: z.array(z.string()),
  proseFeatures: z.array(genreFeatureObservationSchema),
  rhythmFeatures: z.array(genreFeatureObservationSchema),
  dialogueFeatures: z.array(genreFeatureObservationSchema),
  descriptionFeatures: z.array(genreFeatureObservationSchema),
  interiorityFeatures: z.array(genreFeatureObservationSchema),
  pacingFeatures: z.array(genreFeatureObservationSchema),
  informationDisclosureFeatures: z.array(genreFeatureObservationSchema),
  emotionalEffectFeatures: z.array(genreFeatureObservationSchema),
  narrativeFunctions: z.array(genreFeatureObservationSchema),
  scenePatterns: z.array(genreScenePatternObservationSchema),
  characterFunctions: z.array(genreFeatureObservationSchema),
  worldbuildingFunctions: z.array(genreFeatureObservationSchema),
  genreSignals: z.array(genreFeatureObservationSchema),
  nonGenreSignals: z.array(genreFeatureObservationSchema),
  workSpecificFeatures: z.array(genreFeatureObservationSchema),
  possibleFailureModes: z.array(genreFeatureObservationSchema),
  generationGuidance: z.array(genreFeatureObservationSchema),
  confidence: z.number().min(0).max(1),
});

export interface GenreSourceSynthesis {
  sourceSummary: string;
  contributionToGenre: string[];
  deviationsFromGenre: string[];
  workSpecificElements: string[];
  readerExpectations: string[];
  structuralPatterns: string[];
  stylisticPatterns: string[];
  failureRisks: string[];
}

export const genreSourceSynthesisSchema = z.object({
  sourceSummary: z.string(),
  contributionToGenre: z.array(z.string()),
  deviationsFromGenre: z.array(z.string()),
  workSpecificElements: z.array(z.string()),
  readerExpectations: z.array(z.string()),
  structuralPatterns: z.array(z.string()),
  stylisticPatterns: z.array(z.string()),
  failureRisks: z.array(z.string()),
});

export interface GenreAnalysisRun {
  id: string;
  genreId: string;
  sourceId: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  sourceHash: string;
  promptVersion: string;
  provider: string;
  model: string;
  totalSegments: number;
  completedSegments: number;
  failedSegments: number;
  segmentResults: GenreSegmentAnalysis[];
  synthesis?: GenreSourceSynthesis;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

export const genreAnalysisRunSchema = z.object({
  id: z.string(),
  genreId: z.string(),
  sourceId: z.string(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled"]),
  sourceHash: z.string(),
  promptVersion: z.string(),
  provider: z.string(),
  model: z.string(),
  totalSegments: z.number().int().min(0),
  completedSegments: z.number().int().min(0),
  failedSegments: z.number().int().min(0),
  segmentResults: z.array(genreSegmentAnalysisSchema),
  synthesis: genreSourceSynthesisSchema.optional(),
  error: z.string().optional(),
  startedAt: z.string(),
  completedAt: z.string().optional(),
});

export interface GenreAnalysisListDocument {
  schemaVersion: typeof GENRE_SCHEMA_VERSION;
  runs: GenreAnalysisRun[];
}

export const genreAnalysisListDocumentSchema = z.object({
  schemaVersion: z.literal(GENRE_SCHEMA_VERSION),
  runs: z.array(genreAnalysisRunSchema),
});

// ============================================================================
// Knowledge
// ============================================================================

export type GenreKnowledgeCategory =
  | "definition"
  | "core_requirement"
  | "frequent_feature"
  | "optional_feature"
  | "boundary_condition"
  | "genre_differentiator"
  | "prose_style"
  | "narrative_structure"
  | "scene_pattern"
  | "character_function"
  | "worldbuilding_function"
  | "reader_contract"
  | "emotional_effect"
  | "generation_guidance"
  | "prohibition"
  | "failure_mode"
  | "evaluation_criterion";

export const genreKnowledgeCategorySchema = z.enum([
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
]);

export interface GenreEvidenceReference {
  sourceId: string;
  analysisRunId?: string;
  segmentId?: string;
  note?: string;
}

export const genreEvidenceReferenceSchema = z.object({
  sourceId: z.string(),
  analysisRunId: z.string().optional(),
  segmentId: z.string().optional(),
  note: z.string().optional(),
});

export interface GenreChatReference {
  threadId: string;
  messageIds: string[];
}

export const genreChatReferenceSchema = z.object({
  threadId: z.string(),
  messageIds: z.array(z.string()),
});

export interface GenreKnowledgeCandidate {
  id: string;
  genreId: string;
  category: GenreKnowledgeCategory;
  title: string;
  statement: string;
  explanation: string;
  proposedImportance: "core" | "frequent" | "optional" | "boundary" | "work_specific";
  status: "pending" | "accepted" | "rejected" | "on_hold" | "merged";
  confidence: number;
  origin: "source_analysis" | "genre_chat" | "manual" | "aggregation";
  sourceReferences: GenreEvidenceReference[];
  chatReferences: GenreChatReference[];
  createdBy: "ai" | "user";
  createdAt: string;
  updatedAt: string;
}

export const genreKnowledgeCandidateSchema = z.object({
  id: z.string(),
  genreId: z.string(),
  category: genreKnowledgeCategorySchema,
  title: z.string(),
  statement: z.string(),
  explanation: z.string(),
  proposedImportance: z.enum(["core", "frequent", "optional", "boundary", "work_specific"]),
  status: z.enum(["pending", "accepted", "rejected", "on_hold", "merged"]),
  confidence: z.number().min(0).max(1),
  origin: z.enum(["source_analysis", "genre_chat", "manual", "aggregation"]),
  sourceReferences: z.array(genreEvidenceReferenceSchema),
  chatReferences: z.array(genreChatReferenceSchema),
  createdBy: z.enum(["ai", "user"]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export interface GenreKnowledgeItem {
  id: string;
  genreId: string;
  category: GenreKnowledgeCategory;
  title: string;
  statement: string;
  explanation: string;
  importance: "core" | "frequent" | "optional" | "boundary";
  status: "active" | "disabled" | "deprecated";
  confidence: number;
  authority: "user_explicit" | "user_approved_ai" | "imported";
  sourceReferences: GenreEvidenceReference[];
  chatReferences: GenreChatReference[];
  createdFromCandidateId?: string;
  createdAt: string;
  updatedAt: string;
}

export const genreKnowledgeItemSchema = z.object({
  id: z.string(),
  genreId: z.string(),
  category: genreKnowledgeCategorySchema,
  title: z.string(),
  statement: z.string(),
  explanation: z.string(),
  importance: z.enum(["core", "frequent", "optional", "boundary"]),
  status: z.enum(["active", "disabled", "deprecated"]),
  confidence: z.number().min(0).max(1),
  authority: z.enum(["user_explicit", "user_approved_ai", "imported"]),
  sourceReferences: z.array(genreEvidenceReferenceSchema),
  chatReferences: z.array(genreChatReferenceSchema),
  createdFromCandidateId: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export interface GenreKnowledgeDocument {
  schemaVersion: typeof GENRE_SCHEMA_VERSION;
  genreId: string;
  revision: number;
  items: GenreKnowledgeItem[];
  candidates: GenreKnowledgeCandidate[];
  updatedAt: string;
}

export const genreKnowledgeDocumentSchema = z.object({
  schemaVersion: z.literal(GENRE_SCHEMA_VERSION),
  genreId: z.string(),
  revision: z.number().int().min(0),
  items: z.array(genreKnowledgeItemSchema),
  candidates: z.array(genreKnowledgeCandidateSchema),
  updatedAt: z.string(),
});

export function isGenreKnowledgeDocument(
  value: unknown,
): value is GenreKnowledgeDocument {
  return genreKnowledgeDocumentSchema.safeParse(value).success;
}

export interface GenreKnowledgeHistoryDocument {
  schemaVersion: typeof GENRE_SCHEMA_VERSION;
  genreId: string;
  revision: number;
  items: GenreKnowledgeItem[];
  createdAt: string;
}

export const genreKnowledgeHistoryDocumentSchema = z.object({
  schemaVersion: z.literal(GENRE_SCHEMA_VERSION),
  genreId: z.string(),
  revision: z.number().int().min(0),
  items: z.array(genreKnowledgeItemSchema),
  createdAt: z.string(),
});

// ============================================================================
// Chat
// ============================================================================

export interface GenreChatThread {
  id: string;
  genreId: string;
  title: string;
  summary: string;
  status: "active" | "archived";
  lastProvider?: string;
  lastModel?: string;
  createdAt: string;
  updatedAt: string;
}

export const genreChatThreadSchema = z.object({
  id: z.string(),
  genreId: z.string(),
  title: z.string(),
  summary: z.string(),
  status: z.enum(["active", "archived"]),
  lastProvider: z.string().optional(),
  lastModel: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export interface GenreChatToolCall {
  id: string;
  name: string;
  input: unknown;
  output?: unknown;
  error?: string;
}

export const genreChatToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
  output: z.unknown().optional(),
  error: z.string().optional(),
});

export interface GenreChatMessage {
  id: string;
  threadId: string;
  role: "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  excludeFromContext?: boolean;
  provider?: string;
  model?: string;
  finishReason?: string;
  toolCalls?: GenreChatToolCall[];
  referencedSourceIds?: string[];
  referencedSegmentIds?: string[];
  referencedKnowledgeItemIds?: string[];
  referencedCandidateIds?: string[];
  contextSnapshotId?: string;
  createdAt: string;
}

export const genreChatMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  role: z.enum(["user", "assistant", "tool"]),
  content: z.string(),
  thinking: z.string().optional(),
  excludeFromContext: z.boolean().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  finishReason: z.string().optional(),
  toolCalls: z.array(genreChatToolCallSchema).optional(),
  referencedSourceIds: z.array(z.string()).optional(),
  referencedSegmentIds: z.array(z.string()).optional(),
  referencedKnowledgeItemIds: z.array(z.string()).optional(),
  referencedCandidateIds: z.array(z.string()).optional(),
  contextSnapshotId: z.string().optional(),
  createdAt: z.string(),
});

export interface GenreChatDocument {
  schemaVersion: typeof GENRE_SCHEMA_VERSION;
  thread: GenreChatThread;
  messages: GenreChatMessage[];
}

export const genreChatDocumentSchema = z.object({
  schemaVersion: z.literal(GENRE_SCHEMA_VERSION),
  thread: genreChatThreadSchema,
  messages: z.array(genreChatMessageSchema),
});

export function isGenreChatDocument(value: unknown): value is GenreChatDocument {
  return genreChatDocumentSchema.safeParse(value).success;
}

export interface GenreChatThreadListDocument {
  schemaVersion: typeof GENRE_SCHEMA_VERSION;
  threads: GenreChatThread[];
}

export const genreChatThreadListDocumentSchema = z.object({
  schemaVersion: z.literal(GENRE_SCHEMA_VERSION),
  threads: z.array(genreChatThreadSchema),
});

export interface GenreChatContextSnapshot {
  id: string;
  genreId: string;
  threadId: string;
  genreRevision: number;
  knowledgeItemIds: string[];
  candidateIds: string[];
  sourceIds: string[];
  segmentIds: string[];
  historyMessageIds: string[];
  usedThreadSummary: boolean;
  provider: string;
  model: string;
  createdAt: string;
}

export const genreChatContextSnapshotSchema = z.object({
  id: z.string(),
  genreId: z.string(),
  threadId: z.string(),
  genreRevision: z.number().int().min(0),
  knowledgeItemIds: z.array(z.string()),
  candidateIds: z.array(z.string()),
  sourceIds: z.array(z.string()),
  segmentIds: z.array(z.string()),
  historyMessageIds: z.array(z.string()),
  usedThreadSummary: z.boolean(),
  provider: z.string(),
  model: z.string(),
  createdAt: z.string(),
});

export interface GenreChatConclusionExtraction {
  newKnowledgeCandidates: Array<{
    category: GenreKnowledgeCategory;
    title: string;
    statement: string;
    explanation: string;
    proposedImportance: GenreKnowledgeCandidate["proposedImportance"];
  }>;
  updateCandidates: Array<{
    targetKnowledgeItemId: string;
    proposedStatement: string;
    reason: string;
  }>;
  contradictions: Array<{
    knowledgeItemIds: string[];
    description: string;
  }>;
  unresolvedQuestions: string[];
  requiredAdditionalSources: string[];
  workSpecificItems: string[];
}

export const genreChatConclusionExtractionSchema = z.object({
  newKnowledgeCandidates: z.array(
    z.object({
      category: genreKnowledgeCategorySchema,
      title: z.string(),
      statement: z.string(),
      explanation: z.string(),
      proposedImportance: z.enum(["core", "frequent", "optional", "boundary", "work_specific"]),
    }),
  ),
  updateCandidates: z.array(
    z.object({
      targetKnowledgeItemId: z.string(),
      proposedStatement: z.string(),
      reason: z.string(),
    }),
  ),
  contradictions: z.array(
    z.object({
      knowledgeItemIds: z.array(z.string()),
      description: z.string(),
    }),
  ),
  unresolvedQuestions: z.array(z.string()),
  requiredAdditionalSources: z.array(z.string()),
  workSpecificItems: z.array(z.string()),
});

// ============================================================================
// Search
// ============================================================================

export type GenreSearchDocumentType =
  | "source_segment"
  | "accepted_knowledge"
  | "knowledge_candidate"
  | "chat_message";

export const genreSearchDocumentTypeSchema = z.enum([
  "source_segment",
  "accepted_knowledge",
  "knowledge_candidate",
  "chat_message",
]);

export interface GenreSearchDocument {
  documentType: GenreSearchDocumentType;
  genreId: string;
  sourceId?: string;
  segmentId?: string;
  knowledgeItemId?: string;
  candidateId?: string;
  threadId?: string;
  messageId?: string;
  title: string;
  heading?: string;
  body: string;
  author?: string;
  sourceType?: string;
  sourceRole?: string;
  category?: string;
  tags: string[];
  ordinal?: number;
  updatedAt: string;
  contentHash?: string;
}

export interface GenreSearchOptions {
  genreId?: string;
  documentTypes?: GenreSearchDocumentType[];
  sourceIds?: string[];
  categories?: GenreKnowledgeCategory[];
  limit?: number;
  offset?: number;
  includePendingCandidates?: boolean;
  includeDisabledKnowledge?: boolean;
  includeExcludedChatMessages?: boolean;
}

export interface GenreSearchResult {
  documentType: GenreSearchDocumentType;
  genreId: string;
  sourceId?: string;
  segmentId?: string;
  knowledgeItemId?: string;
  candidateId?: string;
  threadId?: string;
  messageId?: string;
  title: string;
  heading?: string;
  snippet: string;
  score: number;
  updatedAt: string;
}

export interface GenreSearchIndexMetadata {
  schemaVersion: number;
  builtAt: string;
}

export const genreSearchIndexMetadataSchema = z.object({
  schemaVersion: z.number().int(),
  builtAt: z.string(),
});

// ============================================================================
// Inputs
// ============================================================================

export interface CreateGenreInput {
  name: string;
  description?: string;
}

export interface UpdateGenreInput {
  name?: string;
  aliases?: string[];
  description?: string;
  userDefinition?: string;
  notes?: string;
  tags?: string[];
  status?: "active" | "archived";
}

export interface CreateGenreSourceInput {
  title: string;
  author?: string;
  sourceType?: GenreSourceType;
  sourceRole?: GenreSourceRole;
  preference?: GenreSourcePreference;
  sourceNote?: string;
  userInterpretation?: string;
  originalFileName?: string;
  content: string;
}

export interface UpdateGenreSourceInput {
  title?: string;
  author?: string;
  sourceType?: GenreSourceType;
  sourceRole?: GenreSourceRole;
  preference?: GenreSourcePreference;
  sourceNote?: string;
  userInterpretation?: string;
  content?: string;
}

export interface CreateGenreKnowledgeItemInput {
  category: GenreKnowledgeCategory;
  title: string;
  statement: string;
  explanation?: string;
  importance?: GenreKnowledgeItem["importance"];
  sourceReferences?: GenreEvidenceReference[];
  chatReferences?: GenreChatReference[];
}

export interface UpdateGenreKnowledgeItemInput {
  category?: GenreKnowledgeCategory;
  title?: string;
  statement?: string;
  explanation?: string;
  importance?: GenreKnowledgeItem["importance"];
  status?: GenreKnowledgeItem["status"];
  sourceReferences?: GenreEvidenceReference[];
  chatReferences?: GenreChatReference[];
}
