import { z } from "zod";
import {
  genreKnowledgeCategorySchema,
  genreSourceRoleSchema,
  genreSourceTypeSchema,
} from "./schema.ts";

/**
 * AI にセグメント分析を依頼した際の出力スキーマ。
 * ID 系は実行時に付与するため、AI 出力には含めない。
 */

export const aiFeatureObservationSchema = z.object({
  statement: z.string().describe("その特徴を1文で簡潔に述べる。"),
  explanation: z.string().describe("なぜその特徴と判断したか、根拠を日本語で説明する。"),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("0.0〜1.0 の確信度。複数資料で確認できれば高く、推測が多ければ低くする。"),
  evidenceExcerpts: z
    .array(z.string())
    .max(3)
    .describe("判断の根拠となった原文の短い抜粋。最大3つ。長文は避ける。"),
});

export const aiScenePatternObservationSchema = z.object({
  name: z.string().describe("場面パターンの名前。"),
  purpose: z.string().describe("そのパターンが持つ機能や目的。"),
  prerequisites: z.array(z.string()).describe("パターンが成立する前提条件。"),
  progression: z.array(z.string()).describe("パターンの展開ステップ。"),
  expectedEffect: z.string().describe("読者に与えられると考えられる効果。"),
  avoid: z.array(z.string()).describe("このパターンを模倣する際に避けるべき陳腐化や誤用。"),
  confidence: z.number().min(0).max(1),
  evidenceExcerpts: z.array(z.string()).max(3),
});

export const aiSegmentAnalysisSchema = z.object({
  summary: z.string().describe("セグメントの内容を1〜3文で要約する。"),
  pointOfView: z.array(z.string()).describe("視点（一人称、三人称、語り手の距離など）。"),
  narratorCharacteristics: z
    .array(z.string())
    .describe("語り手の特徴（客観性、信頼性、知識の範囲など）。"),

  proseFeatures: z.array(aiFeatureObservationSchema).describe("散文の特徴。"),
  rhythmFeatures: z.array(aiFeatureObservationSchema).describe("リズムの特徴。"),
  dialogueFeatures: z.array(aiFeatureObservationSchema).describe("会話の特徴。"),
  descriptionFeatures: z.array(aiFeatureObservationSchema).describe("描写の特徴。"),
  interiorityFeatures: z.array(aiFeatureObservationSchema).describe("心理描写の特徴。"),

  pacingFeatures: z.array(aiFeatureObservationSchema).describe("テンポの特徴。"),
  informationDisclosureFeatures: z
    .array(aiFeatureObservationSchema)
    .describe("情報開示の特徴。"),
  emotionalEffectFeatures: z.array(aiFeatureObservationSchema).describe("感情効果の特徴。"),

  narrativeFunctions: z.array(aiFeatureObservationSchema).describe("物語機能。"),
  scenePatterns: z.array(aiScenePatternObservationSchema).describe("場面パターン。"),
  characterFunctions: z.array(aiFeatureObservationSchema).describe("キャラクター機能。"),
  worldbuildingFunctions: z.array(aiFeatureObservationSchema).describe("世界設定の利用法。"),

  genreSignals: z.array(aiFeatureObservationSchema).describe("ジャンルらしさを示す特徴。"),
  nonGenreSignals: z
    .array(aiFeatureObservationSchema)
    .describe("ジャンル固有ではない一般的な特徴。"),
  workSpecificFeatures: z
    .array(aiFeatureObservationSchema)
    .describe("特定作品だけの特徴。ジャンル一般化に注意。"),

  possibleFailureModes: z
    .array(aiFeatureObservationSchema)
    .describe("AIがこの特徴を模倣する際の失敗リスク。"),
  generationGuidance: z
    .array(aiFeatureObservationSchema)
    .describe("生成時の推奨・注意事項。"),

  overallConfidence: z
    .number()
    .min(0)
    .max(1)
    .describe("このセグメント分析全体の確信度。"),
});

export type AiSegmentAnalysis = z.infer<typeof aiSegmentAnalysisSchema>;

export const aiSourceSynthesisSchema = z.object({
  sourceSummary: z.string().describe("資料全体の要約。"),
  contributionToGenre: z
    .array(z.string())
    .describe("この資料がジャンル定義にどう貢献するか。"),
  deviationsFromGenre: z
    .array(z.string())
    .describe("この資料が一般的なジャンルから逸脱している点。"),
  workSpecificElements: z
    .array(z.string())
    .describe("作品固有の要素。ジャンル一般化しない。"),
  readerExpectations: z
    .array(z.string())
    .describe("この資料から読み取れる読者の期待。"),
  structuralPatterns: z.array(z.string()).describe("構造的パターン。"),
  stylisticPatterns: z.array(z.string()).describe("文体的パターン。"),
  failureRisks: z
    .array(z.string())
    .describe("AIがこの資料を模倣する際の失敗リスク。"),
});

export type AiSourceSynthesis = z.infer<typeof aiSourceSynthesisSchema>;

export const aiKnowledgeCandidateSchema = z.object({
  category: genreKnowledgeCategorySchema,
  title: z.string().describe("知識候補の短いタイトル。"),
  statement: z.string().describe("知識候補の主張。"),
  explanation: z.string().describe("主張の根拠や補足。"),
  proposedImportance: z
    .enum(["core", "frequent", "optional", "boundary", "work_specific"])
    .describe("この候補の重要度提案。"),
  confidence: z.number().min(0).max(1),
  evidenceSegmentIds: z.array(z.string()).describe("根拠となったセグメントID。"),
});

export const aiKnowledgeCandidateExtractionSchema = z.object({
  candidates: z.array(aiKnowledgeCandidateSchema),
});

export type AiKnowledgeCandidateExtraction = z.infer<typeof aiKnowledgeCandidateExtractionSchema>;

export const aiChatConclusionExtractionSchema = z.object({
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

export type AiChatConclusionExtraction = z.infer<typeof aiChatConclusionExtractionSchema>;

export const sourceMetadataForPromptSchema = z.object({
  title: z.string(),
  author: z.string(),
  sourceType: genreSourceTypeSchema,
  sourceRole: genreSourceRoleSchema,
  preference: z.enum(["positive", "negative", "neutral", "not_applicable"]),
  userInterpretation: z.string(),
});
