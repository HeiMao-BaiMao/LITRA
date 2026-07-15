import { isLoopFinished, stepCountIs, streamText, type ModelMessage, type StopCondition, type TextStreamPart, type ToolSet } from "ai";
import { createModel } from "./provider.ts";
import { buildProviderOptions, buildRetryOption, isGemini3Model } from "./provider-options.ts";
import {
  buildAssistantSystemPrompt,
  buildCharacterVoiceCardsPrompt,
  buildCandidateSelectionPrompt,
  buildContinuationPlanPrompt,
  buildContinuationPrompt,
  buildContinuationRevisionPrompt,
  buildContinuationReviewPrompt,
  buildDraftSelectionPrompt,
  buildFeedbackPrompt,
  buildLineEditReviewPrompt,
  buildLineEditRevisionPrompt,
  buildRewritePrompt,
  buildSceneStateCardPrompt,
  buildTargetedRevisionPrompt,
  buildToolCallNeedPrompt,
  formatMechanicalFindingsForReview,
  limitPromptText,
  parseDraftSelection,
  parseTargetedRevision,
  reviewRequiresRevision,
  toolCallNeedSchema,
  type FictionPromptExtras,
  type PromptScaffoldLevel,
} from "./prompts.ts";
import { checkDraft, sanitizeDraftText } from "./draft-checks.ts";
import { parsePlanBeats } from "./plan-beats.ts";
import type { AiSettings } from "../settings.ts";
import {
  loadPersistentAiArtifact,
  recordProviderCacheUsage,
  savePersistentAiArtifact,
} from "./cache-observability.ts";
import {
  streamRustText,
  type RustChatMessage,
  type RustTextStreamResult,
} from "./rust-transport.ts";
import { executeRustToolCalls, serializeRustTools } from "./rust-tools.ts";

// ビート分割生成で前ビートの生成分を文脈に継ぎ足す際、無制限に伸びないための上限
const BEAT_CONTEXT_CHAR_BUDGET = 12000;
const CONTINUATION_LENGTH_RETRY_LIMIT = 2;

const DEFAULT_ANTHROPIC_THINKING_BUDGET = 8000;
// 非ストリーミング(generateText)の背景ステップ用の出力上限。
// 16K 超の非ストリーミング要求は HTTP タイムアウト域に入るため、
// thinking トークンの余裕を残しつつ 32K に制限する
// (従来は settings.maxTokens をそのまま使っており、DeepSeek の既定 384000 等が渡っていた)。
const NONSTREAMING_MAX_OUTPUT_TOKENS = 32768;
const TOOL_LOOP_MAX_STEPS = 16;
const DUPLICATE_TOOL_CALL_INPUT_LIMIT = 4;
let aiStepSequence = 0;

interface AiStepLog {
  id: number;
  name: string;
  startedAt: number;
}

function beginAiStep(name: string, settings: AiSettings): AiStepLog {
  const step = { id: ++aiStepSequence, name, startedAt: performance.now() };
  console.log(`[litra:ai-step:${step.id}] START ${name}`, {
    provider: settings.provider,
    model: settings.model,
  });
  return step;
}

function completeAiStep(step: AiStepLog, output: unknown, finishReason?: string): void {
  console.log(`[litra:ai-step:${step.id}] COMPLETE ${step.name}`, {
    durationMs: Math.round(performance.now() - step.startedAt),
    finishReason: finishReason ?? "unknown",
  });
  console.log(`[litra:ai-step:${step.id}] OUTPUT ${step.name}`, output);
}

function failAiStep(step: AiStepLog, error: unknown): void {
  console.error(`[litra:ai-step:${step.id}] FAILED ${step.name}`, {
    durationMs: Math.round(performance.now() - step.startedAt),
    error,
  });
}

async function generateLoggedText(
  name: string,
  settings: AiSettings,
  options: {
    prompt: string;
    system?: string;
    maxOutputTokens?: number;
    abortSignal?: AbortSignal;
    [key: string]: unknown;
  },
): Promise<{ text: string; reasoningText?: string; finishReason?: string }> {
  const step = beginAiStep(name, settings);
  try {
    let text = "";
    let reasoningText = "";
    const result = await streamRustText(settings, {
      system: options.system ?? "",
      prompt: options.prompt,
      maxOutputTokens: options.maxOutputTokens ?? NONSTREAMING_MAX_OUTPUT_TOKENS,
      abortSignal: options.abortSignal,
      onChunk: (chunk) => { text += chunk; },
      onReasoning: (chunk) => { reasoningText += chunk; },
    });
    if (reasoningText) {
      console.log(`[litra:ai-step:${step.id}] REASONING ${step.name}`, reasoningText);
    }
    completeAiStep(step, text, result.finishReason);
    return { text, reasoningText: reasoningText || undefined, finishReason: result.finishReason };
  } catch (error) {
    failAiStep(step, error);
    throw error;
  }
}

function isDeepSeekThinkingEnabled(settings: AiSettings): boolean {
  // DeepSeek V3.2 以降、thinking モードはツール呼び出しと両立する
  // (ツール有効時の強制 OFF は V3 時代の制約なので廃止)。
  // thinking 中は温度・top_p・ペナルティ類のサンプリングパラメータが無視される。
  return settings.provider === "deepseek" && settings.deepseekThinkingEnabled !== false;
}

function isGoogleGemini3(settings: AiSettings): boolean {
  return settings.provider === "google" && isGemini3Model(settings.model);
}

// Anthropic Messages 系(直接 / Copilot 経由 Claude)かどうか。
// Claude 4 以降は temperature と top_p の併送が 400 になるため temperature のみ送る。
function isAnthropicMessagesModel(settings: AiSettings): boolean {
  return (
    settings.provider === "anthropic" ||
    (settings.provider === "github-copilot" && settings.model.startsWith("claude-"))
  );
}

function buildTemperatureOption(settings: AiSettings) {
  // DeepSeek の thinking モードでは temperature は無視される。
  // OpenCode Go プロバイダでは OpenCode クライアントに合わせて temperature を送らない
  // (OpenCode の transform.ts:481-498 で DeepSeek/GLM/MiniMax/MiMo 等は undefined を返す)。
  if (isDeepSeekThinkingEnabled(settings)) return {};
  if (settings.provider === "opencode") return {};
  // Gemini 3 系は「temperature は既定値 1.0 のまま変更しない」ことが公式に強く
  // 推奨されており、変更するとループや推論品質の劣化を招き得るため送らない。
  if (isGoogleGemini3(settings)) return {};
  return { temperature: settings.temperature };
}

function buildAdvancedOptions(settings: AiSettings) {
  const providerOptions = buildProviderOptions(settings);
  // OpenCode Go プロバイダでは OpenCode クライアントに合わせるため、
  // topP / topK / frequencyPenalty / presencePenalty をすべて送らない
  // (transform.ts:500-507 と native-request.ts:135-143 で populate されない)。
  // Gemini 3 系も同様に、topP/topK 等の sampling params は公式に非推奨となり
  // thinkingConfig.thinkingLevel（buildProviderOptions 経由）に置き換わっている。
  // Anthropic Messages 系は temperature と top_p の併送が Claude 4+ で 400 になり、
  // ペナルティ類も API に存在しないため、これらを送らない(temperature のみ)。
  const ignoreSampling =
    isDeepSeekThinkingEnabled(settings) ||
    settings.provider === "opencode" ||
    isGoogleGemini3(settings) ||
    isAnthropicMessagesModel(settings);
  const ignorePenalty = settings.provider === "sakura" || settings.provider === "opencode";
  return {
    ...(!ignoreSampling && settings.topP !== undefined && { topP: settings.topP }),
    ...(!ignoreSampling && settings.topK !== undefined && { topK: settings.topK }),
    ...(!ignoreSampling && !ignorePenalty && settings.frequencyPenalty !== undefined && {
      frequencyPenalty: settings.frequencyPenalty,
    }),
    ...(!ignoreSampling && !ignorePenalty && settings.presencePenalty !== undefined && {
      presencePenalty: settings.presencePenalty,
    }),
    ...(providerOptions && { providerOptions }),
  };
}

/**
 * ツール呼び出しを強制したい局面で使う tool_choice を解決する。
 * - OpenCode Go: OpenCode クライアントに合わせて送らない
 * - DeepSeek thinking 有効時: "required"/特定関数指定は 400 になるため "auto"
 * - Anthropic 系で thinking が有効(Fable 5 は常時有効)な場合: "required"
 *   (= {type:"any"}) は thinking と両立しないため "auto"
 * - それ以外: "required"
 */
export function resolveForcedToolChoice(settings: AiSettings): "required" | "auto" | undefined {
  if (settings.provider === "opencode") return undefined;
  if (settings.provider === "deepseek") {
    return isDeepSeekThinkingEnabled(settings) ? "auto" : "required";
  }
  if (isAnthropicMessagesModel(settings)) {
    if (settings.model.includes("fable") || settings.model.includes("mythos")) return "auto";
    const thinking = buildProviderOptions(settings)?.anthropic?.thinking;
    const thinkingType =
      thinking && typeof thinking === "object" && !Array.isArray(thinking)
        ? (thinking as { type?: unknown }).type
        : undefined;
    if (thinkingType === "adaptive" || thinkingType === "enabled") return "auto";
  }
  return "required";
}

function hasTools(tools: ToolSet | undefined): tools is ToolSet {
  if (tools == null || Object.keys(tools).length === 0) return false;
  return true;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function duplicateToolCallInputCountIs(limit: number): StopCondition<any> {
  return ({ steps }) => {
    const counts = new Map<string, number>();
    for (const step of steps) {
      for (const toolCall of step.toolCalls) {
        const key = `${toolCall.toolName}:${stableStringify(toolCall.input)}`;
        const nextCount = (counts.get(key) ?? 0) + 1;
        if (nextCount >= limit) {
          console.warn("[litra:ai] stopping repeated tool call loop:", {
            toolName: toolCall.toolName,
            repeatedCalls: nextCount,
          });
          return true;
        }
        counts.set(key, nextCount);
      }
    }
    return false;
  };
}

function toolLoopStopConditions(
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>,
): Array<StopCondition<ToolSet>> {
  const base = Array.isArray(stopWhen)
    ? stopWhen
    : stopWhen
      ? [stopWhen]
      : [isLoopFinished() as StopCondition<ToolSet>];
  return [
    ...base,
    stepCountIs(TOOL_LOOP_MAX_STEPS) as StopCondition<ToolSet>,
    duplicateToolCallInputCountIs(DUPLICATE_TOOL_CALL_INPUT_LIMIT) as StopCondition<ToolSet>,
  ];
}

/**
 * continuePassage はチャットから専用執筆パイプラインへ入るための入口であり、
 * パイプライン内部で再公開すると自己呼び出しになる。呼び出し側の指定にかかわらず除外する。
 */
export function scopeContinuationTools(tools?: ToolSet): ToolSet | undefined {
  if (!tools) return tools;
  // 生成パイプライン自身から、生成入口と提案キャッシュの変更系ツールを隔離する。
  // これらは外側のチャットエージェントだけが呼び、執筆モデルには公開しない。
  const {
    continuePassage: _continuePassage,
    listPassageProposals: _listPassageProposals,
    getPassageProposal: _getPassageProposal,
    applyPassageProposal: _applyPassageProposal,
    ...scoped
  } = tools;
  return Object.keys(scoped).length > 0 ? scoped : undefined;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function trimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptionalRange(
  value: number | undefined,
  min: number,
  max: number,
): number | undefined {
  if (!isFiniteNumber(value) || value < min || value > max) return undefined;
  return value;
}

export interface StreamRunResult {
  textChunkCount: number;
  textCharCount: number;
  reasoningChunkCount: number;
  reasoningCharCount: number;
  toolCallCount: number;
  toolResultCount: number;
  toolErrorCount: number;
  finishReason?: string;
  response?: {
    id: string;
    modelId: string;
    timestamp?: string;
  };
  stoppedAfterToolResult: boolean;
  stoppedAfterToolActivity: boolean;
  pendingToolCallIds: string[];
  responseMessages: ModelMessage[];
}

function rustTextResultToRunResult(
  result: RustTextStreamResult,
  assistantText = "",
): StreamRunResult {
  return {
    ...result,
    toolCallCount: 0,
    toolResultCount: 0,
    toolErrorCount: 0,
    stoppedAfterToolResult: false,
    stoppedAfterToolActivity: false,
    pendingToolCallIds: [],
    responseMessages: assistantText
      ? [{ role: "assistant", content: assistantText }]
      : [],
  };
}

export type StreamToolEvent =
  | {
      type: "progress";
      toolCallId: string;
      toolName: string;
      phase: string;
      label: string;
      step?: number;
      totalSteps?: number;
      model?: string;
    }
  | {
      type: "input-start";
      toolCallId: string;
      toolName: string;
    }
  | {
      type: "call";
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      type: "result";
      toolCallId: string;
      toolName: string;
      input: unknown;
      output: unknown;
    }
  | {
      type: "error";
      toolCallId: string;
      toolName: string;
      input: unknown;
      error: unknown;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getStringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function extractReasoningChunk(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined;
  const type = part.type;
  if (type !== "reasoning-delta" && type !== "reasoning") return undefined;
  return getStringField(part, ["delta", "text", "textDelta"]);
}

function extractTextChunk(part: unknown): string | undefined {
  if (!isRecord(part)) return undefined;
  const type = part.type;
  if (type !== "text-delta" && type !== "text") return undefined;
  return getStringField(part, ["delta", "text", "textDelta"]);
}

const THINK_OPEN_TAGS = ["<think>", "<thinking>"];
const THINK_CLOSE_TAGS = ["</think>", "</thinking>"];

interface ThinkTagRouter {
  push(chunk: string): void;
  flush(): void;
}

/**
 * OpenAI 互換プロバイダの一部は思考過程を reasoning-delta ではなく、
 * 本文ストリーム中の <think>...</think> として返す。タグ内を思考として
 * 分離し、本文へ混入させない。タグがチャンク境界で分割されるケースに
 * 備えて、タグの先頭になり得る末尾文字列はバッファに保持する。
 */
function createThinkTagRouter(
  emitText: (chunk: string) => void,
  emitReasoning: (chunk: string) => void,
): ThinkTagRouter {
  let buffer = "";
  let inThink = false;

  const findFirstTag = (
    text: string,
    tags: string[],
  ): { index: number; tag: string } | undefined => {
    let found: { index: number; tag: string } | undefined;
    for (const tag of tags) {
      const index = text.indexOf(tag);
      if (index >= 0 && (found === undefined || index < found.index)) {
        found = { index, tag };
      }
    }
    return found;
  };

  const partialTagHold = (text: string, tags: string[]): number => {
    let hold = 0;
    for (const tag of tags) {
      const maxLen = Math.min(tag.length - 1, text.length);
      for (let len = maxLen; len > hold; len--) {
        if (text.endsWith(tag.slice(0, len))) {
          hold = len;
          break;
        }
      }
    }
    return hold;
  };

  const emit = (chunk: string): void => {
    if (!chunk) return;
    if (inThink) {
      emitReasoning(chunk);
    } else {
      emitText(chunk);
    }
  };

  return {
    push(chunk: string): void {
      buffer += chunk;
      for (;;) {
        const tags = inThink ? THINK_CLOSE_TAGS : THINK_OPEN_TAGS;
        const match = findFirstTag(buffer, tags);
        if (match) {
          emit(buffer.slice(0, match.index));
          buffer = buffer.slice(match.index + match.tag.length);
          inThink = !inThink;
          continue;
        }
        const hold = partialTagHold(buffer, tags);
        const emitLength = buffer.length - hold;
        if (emitLength > 0) {
          emit(buffer.slice(0, emitLength));
          buffer = buffer.slice(emitLength);
        }
        return;
      }
    },
    flush(): void {
      const rest = buffer;
      buffer = "";
      emit(rest);
    },
  };
}

async function consumeStream(
  result: {
    fullStream: AsyncIterable<TextStreamPart<ToolSet>>;
    response: PromiseLike<{
      id: string;
      modelId: string;
      timestamp?: Date;
      messages: ModelMessage[];
    }>;
  },
  onChunk: (chunk: string) => void,
  onToolEvent?: (event: StreamToolEvent) => void,
  onReasoning?: (chunk: string) => void,
  cacheStat?: { step: string; settings: AiSettings },
): Promise<StreamRunResult> {
  let chunkCount = 0;
  let charCount = 0;
  let reasoningChunkCount = 0;
  let reasoningCharCount = 0;
  let toolCallCount = 0;
  let toolResultCount = 0;
  let toolErrorCount = 0;
  let finishReason: string | undefined;
  let response: StreamRunResult["response"];
  let responseMessages: ModelMessage[] = [];
  let lastSignificantPart: "text" | "reasoning" | "tool-input" | "tool-call" | "tool-result" | "tool-error" | undefined;
  const pendingToolCallIds = new Set<string>();

  const emitReasoning = (chunk: string): void => {
    reasoningChunkCount++;
    reasoningCharCount += chunk.length;
    lastSignificantPart = "reasoning";
    if (reasoningChunkCount <= 3 || reasoningChunkCount % 10 === 0) {
      console.log(`[litra:ai] reasoning chunk #${reasoningChunkCount}:`, chunk.slice(0, 80));
    }
    onReasoning?.(chunk);
  };
  const emitText = (chunk: string): void => {
    chunkCount++;
    charCount += chunk.length;
    lastSignificantPart = "text";
    if (chunkCount <= 3 || chunkCount % 10 === 0) {
      console.log(`[litra:ai] text chunk #${chunkCount}:`, chunk.slice(0, 80));
    }
    onChunk(chunk);
  };
  // <think> タグ入りの本文を、思考と本文へ振り分ける
  const textRouter = createThinkTagRouter(emitText, emitReasoning);

  for await (const part of result.fullStream) {
    const reasoningChunk = extractReasoningChunk(part);
    if (reasoningChunk !== undefined) {
      if (!reasoningChunk) continue;
      emitReasoning(reasoningChunk);
      continue;
    }

    const textChunk = extractTextChunk(part);
    if (textChunk !== undefined) {
      if (!textChunk) continue;
      textRouter.push(textChunk);
      continue;
    }

    switch (part.type) {
      case "tool-input-start": {
        lastSignificantPart = "tool-input";
        pendingToolCallIds.add(part.id);
        console.log(`[litra:ai] tool input start: ${part.toolName}`);
        onToolEvent?.({
          type: "input-start",
          toolCallId: part.id,
          toolName: part.toolName,
        });
        break;
      }
      case "tool-call": {
        toolCallCount++;
        lastSignificantPart = "tool-call";
        pendingToolCallIds.add(part.toolCallId);
        console.log(`[litra:ai] tool call: ${part.toolName}`, part.input);
        onToolEvent?.({
          type: "call",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
        });
        break;
      }
      case "tool-result": {
        if (part.preliminary) break;
        toolResultCount++;
        lastSignificantPart = "tool-result";
        pendingToolCallIds.delete(part.toolCallId);
        console.log(`[litra:ai] tool result: ${part.toolName}`, part.input);
        onToolEvent?.({
          type: "result",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
          output: part.output,
        });
        break;
      }
      case "tool-error": {
        toolErrorCount++;
        lastSignificantPart = "tool-error";
        pendingToolCallIds.delete(part.toolCallId);
        console.error(`[litra:ai] tool error: ${part.toolName}`, part.error);
        onToolEvent?.({
          type: "error",
          toolCallId: part.toolCallId,
          toolName: part.toolName,
          input: part.input,
          error: part.error,
        });
        break;
      }
      case "finish": {
        finishReason = part.finishReason;
        break;
      }
      case "finish-step": {
        if (cacheStat) {
          recordProviderCacheUsage(cacheStat.step, cacheStat.settings, part.providerMetadata);
        }
        response = {
          id: part.response.id,
          modelId: part.response.modelId,
          timestamp: part.response.timestamp instanceof Date
            ? part.response.timestamp.toISOString()
            : undefined,
        };
        break;
      }
      case "error": {
        throw part.error;
      }
    }
  }

  textRouter.flush();

  try {
    const streamResponse = await result.response;
    response = {
      id: streamResponse.id,
      modelId: streamResponse.modelId,
      timestamp: streamResponse.timestamp instanceof Date
        ? streamResponse.timestamp.toISOString()
        : undefined,
    };
    responseMessages = streamResponse.messages;
  } catch (error) {
    console.warn("[litra:ai] failed to read response messages:", error);
  }

  console.log(`[litra:ai] stream finished. text chunks: ${chunkCount}, tool results: ${toolResultCount}, finish: ${finishReason ?? "unknown"}`);
  return {
    textChunkCount: chunkCount,
    textCharCount: charCount,
    reasoningChunkCount,
    reasoningCharCount,
    toolCallCount,
    toolResultCount,
    toolErrorCount,
    finishReason,
    response,
    stoppedAfterToolResult: lastSignificantPart === "tool-result" || lastSignificantPart === "tool-error",
    stoppedAfterToolActivity:
      lastSignificantPart === "tool-input" ||
      lastSignificantPart === "tool-call" ||
      lastSignificantPart === "tool-result" ||
      lastSignificantPart === "tool-error",
    pendingToolCallIds: [...pendingToolCallIds],
    responseMessages,
  };
}

export interface StreamChatOptions {
  settings: AiSettings;
  messages: ModelMessage[];
  onChunk: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
  abortSignal?: AbortSignal;
  settingsContext?: string;
  tools?: ToolSet;
  toolChoice?: "auto" | "none" | "required";
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;
  onToolEvent?: (event: StreamToolEvent) => void;
  directCreativeEdit?: boolean;
}

export interface StreamContinuationOptions {
  settings: AiSettings;
  context: string;
  onChunk: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
  abortSignal?: AbortSignal;
  settingsContext?: string;
  // 直前本文の登場人物の過去場面抜粋(文字列照合+全文検索インデックスのみで生成。LLM呼び出しなし)
  relatedScenes?: string;
  tools?: ToolSet;
  onToolEvent?: (event: StreamToolEvent) => void;
  onStage?: (stage: "plan" | "draft" | "review" | "revise" | "regression") => void;
  // 判断系工程(構想・査読・選定・カード)で使う設定を解決する。
  // 呼び出し側(main.ts)が役割プロファイル・オーバーライドの解決を担う。
  getJudgmentSettings?: () => AiSettings;
  // 文体指紋(機械計測)。呼び出し側で現エピソード全文等から計測して渡す。
  styleFingerprint?: FictionPromptExtras["styleFingerprint"];
  // 場面ステートカード・話し方カードのキャッシュキーに使うエピソードID
  episodeId?: string;
  // 話し方カード(提案7)の対象人物名と、その根拠となる原稿抜粋(文字列照合+検索のみで生成。LLM呼び出しなし)
  characterVoiceInput?: { names: string[]; excerpts: string };
  /** チャットから渡された、この続き生成に固有の作者指示。 */
  authorInstruction?: string;
}

export interface StreamRewriteOptions {
  settings: AiSettings;
  selection: string;
  context: string;
  onChunk: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
  abortSignal?: AbortSignal;
  settingsContext?: string;
  // 作者からの書き直し指示(チャット経由の rewritePassage ツールで使用)。
  // 省略時は従来どおりの無指示リライト。
  instruction?: string;
  /** 複数候補の選定に使う判断系設定。未指定なら単一生成。 */
  judgmentSettings?: AiSettings;
}

export interface StreamFeedbackOptions {
  settings: AiSettings;
  selection: string;
  onChunk: (chunk: string) => void;
  onReasoning?: (chunk: string) => void;
  abortSignal?: AbortSignal;
  settingsContext?: string;
}

async function verifyToolCallNeed(
  settings: AiSettings,
  userRequest: string,
  assistantResponse: string,
  availableToolNames: string[],
  abortSignal?: AbortSignal,
): Promise<boolean> {
  // 非クリティカルな検証呼び出しは長時間待たない。
  // debugFetch のリトライ（最長71秒）を打ち切り、ユーザー体験をブロックしない。
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  if (abortSignal) {
    if (abortSignal.aborted) {
      controller.abort();
    } else {
      abortSignal.addEventListener("abort", () => controller.abort(), { once: true });
    }
  }
  try {
    // generateObject は response_format: json_schema を自動付与するが、
    // OpenCode Go 上流（DeepSeek）が json_schema + strict を処理できず 400 になる。
    // そのため generateText で通常チャットを行い、レスポンスをクライアント側で Zod 検証する。
    const basePrompt = buildToolCallNeedPrompt(userRequest, assistantResponse, availableToolNames);
    const jsonPrompt = `${basePrompt}\n\nReturn ONLY a valid JSON object with this exact shape. No markdown, no code fence, no explanation:\n{"needsTools": boolean, "missingTools": string[], "reason": string}\nIf missingTools is unnecessary, omit it or use an empty array.`;
    const result = await generateLoggedText("tool-call-need-verification", settings, {
      ...buildRetryOption(settings),
      system:
        "You audit assistant responses. Decide one thing: did the request require an actual tool call that the assistant failed to perform? Return ONLY a JSON object. IF uncertain → set needsTools=false.",
      prompt: jsonPrompt,
      maxOutputTokens: 1024,
      temperature: 0.1,
      // DeepSeek はサーバ既定で thinking ON のため、そのままだと推論時間で
      // 15 秒タイムアウトに達し検証が常に失敗する。この判定は軽量で良いので
      // thinking を明示的に無効化する(非 thinking なら temperature 0.1 も効く)。
      ...(settings.provider === "deepseek" && {
        providerOptions: { deepseek: { thinking: { type: "disabled" } } },
      }),
      abortSignal: controller.signal,
    });

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch (error) {
      console.error("[litra:ai] tool-call need JSON parse failed:", error, "raw:", result.text.slice(0, 200));
      return false;
    }
    const validated = toolCallNeedSchema.safeParse(parsed);
    if (!validated.success) {
      console.error("[litra:ai] tool-call need schema validation failed:", validated.error);
      return false;
    }
    console.log("[litra:ai] tool-call need check:", validated.data);
    return validated.data.needsTools;
  } catch (error) {
    console.error("[litra:ai] tool-call need verification failed:", error);
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

function getLastUserMessageContent(messages: ModelMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "user") {
      return typeof message.content === "string" ? message.content : JSON.stringify(message.content);
    }
  }
  return "";
}

function modelMessagesForRust(messages: ModelMessage[]): RustChatMessage[] | undefined {
  const converted: RustChatMessage[] = [];
  for (const message of messages) {
    if (
      message.role !== "system" &&
      message.role !== "user" &&
      message.role !== "assistant" &&
      message.role !== "tool"
    ) {
      return undefined;
    }
    let content: unknown;
    if (typeof message.content === "string") {
      content = message.content;
    } else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (
          typeof part !== "object" ||
          part === null ||
          !("type" in part) ||
          (part.type !== "text" && part.type !== "tool-call" && part.type !== "tool-result")
        ) {
          return undefined;
        }
      }
      content = message.content;
    } else {
      return undefined;
    }
    converted.push({ role: message.role, content });
  }
  return converted;
}

function normalizeSettings(settings: AiSettings): AiSettings {
  const normalized = { ...settings };

  normalized.apiKey = trimmedString(normalized.apiKey);
  normalized.baseUrl = trimmedString(normalized.baseUrl);
  normalized.model = trimmedString(normalized.model);

  if (!isFiniteNumber(normalized.temperature) || normalized.temperature < 0 || normalized.temperature > 2) {
    console.warn(`[litra:ai] invalid temperature ${normalized.temperature}, falling back to 0.7`);
    normalized.temperature = 0.7;
  }

  if (!isFiniteNumber(normalized.maxTokens) || normalized.maxTokens <= 0) {
    console.warn(`[litra:ai] invalid maxTokens ${normalized.maxTokens}, falling back to 8192`);
    normalized.maxTokens = 8192;
  } else {
    normalized.maxTokens = Math.floor(normalized.maxTokens);
  }

  if (!isFiniteNumber(normalized.maxContextTokens) || normalized.maxContextTokens <= 0) {
    console.warn(`[litra:ai] invalid maxContextTokens ${normalized.maxContextTokens}, falling back to 65536`);
    normalized.maxContextTokens = 65536;
  } else {
    normalized.maxContextTokens = Math.floor(normalized.maxContextTokens);
  }

  normalized.topP = normalizeOptionalRange(normalized.topP, 0, 1);
  normalized.topK = isFiniteNumber(normalized.topK) && normalized.topK >= 1 ? Math.floor(normalized.topK) : undefined;
  normalized.frequencyPenalty = normalizeOptionalRange(normalized.frequencyPenalty, -2, 2);
  normalized.presencePenalty = normalizeOptionalRange(normalized.presencePenalty, -2, 2);
  normalized.anthropicThinkingBudget =
    isFiniteNumber(normalized.anthropicThinkingBudget) && normalized.anthropicThinkingBudget > 0
      ? Math.floor(normalized.anthropicThinkingBudget)
      : undefined;
  if (normalized.anthropicThinkingEnabled && normalized.anthropicThinkingBudget === undefined) {
    normalized.anthropicThinkingBudget = DEFAULT_ANTHROPIC_THINKING_BUDGET;
  }
  // Anthropic API は budget_tokens < max_tokens かつ 1024 以上を要求する
  if (
    normalized.anthropicThinkingBudget !== undefined &&
    normalized.anthropicThinkingBudget >= normalized.maxTokens
  ) {
    normalized.anthropicThinkingBudget = Math.max(1024, normalized.maxTokens - 1024);
  }

  return normalized;
}

export async function streamChat({
  settings,
  messages,
  onChunk,
  abortSignal,
  settingsContext,
  tools,
  toolChoice,
  onToolEvent,
  onReasoning,
  directCreativeEdit = false,
}: StreamChatOptions): Promise<StreamRunResult> {
  try {
    const s = normalizeSettings(settings);
    const toolsEnabled = hasTools(tools);
    let assistantText = "";
    const wrappedOnChunk = (chunk: string) => {
      assistantText += chunk;
      onChunk(chunk);
    };
    const toolNames = toolsEnabled ? Object.keys(tools) : [];

    const rustMessages = modelMessagesForRust(messages);
    if (!rustMessages) throw new Error("Rust AI transport が未対応のチャットメッセージ形式です");
    const rustTools = toolsEnabled ? await serializeRustTools(tools) : undefined;
    const result = await streamRustText(s, {
      system: buildAssistantSystemPrompt({ settingsContext, toolsEnabled, toolNames, directCreativeEdit }),
      messages: rustMessages,
      tools: rustTools,
      toolChoice: toolsEnabled ? toolChoice : undefined,
      prompt: "",
      maxOutputTokens: s.maxTokens,
      abortSignal,
      onChunk: wrappedOnChunk,
      onReasoning,
      onToolInputStart: ({ toolCallId, toolName }) =>
        onToolEvent?.({ type: "input-start", toolCallId, toolName }),
    });
    if (toolsEnabled && result.toolCalls.length > 0) {
      const execution = await executeRustToolCalls(
        tools,
        result.toolCalls,
        messages,
        assistantText,
        abortSignal,
        onToolEvent,
      );
      return {
        ...result,
        toolCallCount: result.toolCalls.length,
        toolResultCount: execution.resultCount,
        toolErrorCount: execution.errorCount,
        stoppedAfterToolResult: execution.resultCount + execution.errorCount > 0,
        stoppedAfterToolActivity: true,
        pendingToolCallIds: [],
        responseMessages: execution.responseMessages,
      };
    }

    const runResult = rustTextResultToRunResult(result, assistantText);

    // ツールが有効なのにツール呼び出しがなく、かつ通常終了した場合は検証する
    if (
      toolsEnabled &&
      s.provider !== "sakura" &&
      runResult.toolCallCount === 0 &&
      runResult.finishReason !== "tool-calls" &&
      !abortSignal?.aborted
    ) {
      const userRequest = getLastUserMessageContent(messages);
      const needsTools = await verifyToolCallNeed(s, userRequest, assistantText, toolNames, abortSignal);
      if (needsTools) {
        console.log("[litra:ai] retrying with tool-call requirement");
        const retryMessages: ModelMessage[] = [
          ...messages,
          { role: "assistant", content: assistantText },
          {
            role: "user",
            content:
              "まだ必要なツールを呼び出していないようです。先にツールを呼び出してから、必要であれば説明を続けてください。",
          },
        ];
        const retryRustMessages = modelMessagesForRust(retryMessages);
        if (!retryRustMessages) throw new Error("Rust AI transport が未対応の再試行メッセージ形式です");
        let retryAssistantText = "";
        const retryResult = await streamRustText(s, {
          system: buildAssistantSystemPrompt({ settingsContext, toolsEnabled: true, toolNames, directCreativeEdit }),
          messages: retryRustMessages,
          tools: rustTools,
          toolChoice: resolveForcedToolChoice(s),
          prompt: "",
          maxOutputTokens: s.maxTokens,
          abortSignal,
          onChunk: (chunk) => { retryAssistantText += chunk; onChunk(chunk); },
          onReasoning,
          onToolInputStart: ({ toolCallId, toolName }) =>
            onToolEvent?.({ type: "input-start", toolCallId, toolName }),
        });
        if (retryResult.toolCalls.length === 0) {
          return rustTextResultToRunResult(retryResult, retryAssistantText);
        }
        const execution = await executeRustToolCalls(
          tools,
          retryResult.toolCalls,
          retryMessages,
          retryAssistantText,
          abortSignal,
          onToolEvent,
        );
        return {
          ...retryResult,
          toolCallCount: retryResult.toolCalls.length,
          toolResultCount: execution.resultCount,
          toolErrorCount: execution.errorCount,
          stoppedAfterToolResult: execution.resultCount + execution.errorCount > 0,
          stoppedAfterToolActivity: true,
          pendingToolCallIds: [],
          responseMessages: execution.responseMessages,
        };
      }
    }

    return runResult;
  } catch (error) {
    console.error("streamChat error:", error);
    throw error;
  }
}

/**
 * 続き生成の前に、非表示の構想ステップ(non-streaming)を1回実行する。
 * 弱いモデルほど安易・平坦な続きを選びがちなため、執筆前に展開案を
 * 検討・選択させ、その方針メモを執筆プロンプトへ注入する。
 * 構想ステップ自体が失敗しても続き生成全体を失敗させてはならないため、
 * 例外・空文字はここで吸収し、呼び出し側には undefined を返す(1段生成へフォールバック)。
 */
async function runContinuationPlanStep(
  settings: AiSettings,
  context: string,
  settingsContext: string | undefined,
  relatedScenes: string | undefined,
  abortSignal?: AbortSignal,
  authorInstruction?: string,
): Promise<string | undefined> {
  try {
    const result = await generateLoggedText("continuation-plan", settings, {
      ...buildRetryOption(settings),
      prompt: buildContinuationPlanPrompt(context, settingsContext, relatedScenes, authorInstruction),
      ...buildTemperatureOption(settings),
      // thinking 系モデルでは推論トークンもこの上限を消費するため、
      // 構想の深さを絞らないよう本体生成と同じ上限を使う。
      maxOutputTokens: Math.min(settings.maxTokens, NONSTREAMING_MAX_OUTPUT_TOKENS),
      abortSignal,
      ...buildAdvancedOptions(settings),
    });

    const planText = result.text.trim();
    if (!planText) return undefined;
    console.log("[litra] continuation plan:", planText);
    return planText;
  } catch (error) {
    // ユーザーによる中断はフォールバックせず、そのまま中断として伝播させる。
    if (abortSignal?.aborted) throw error;
    console.warn("[litra] continuation plan step failed; falling back to single-stage", error);
    return undefined;
  }
}

/**
 * 続き生成のドラフトを査読するレビューステップ(non-streaming)。
 * 失敗してもドラフト採用にフォールバックするため、例外・空文字はここで
 * 吸収して undefined を返す(中断だけは伝播)。
 */
async function runContinuationReviewStep(
  settings: AiSettings,
  draft: string,
  context: string,
  settingsContext: string | undefined,
  plan: string | undefined,
  relatedScenes: string | undefined,
  abortSignal?: AbortSignal,
  extras?: FictionPromptExtras,
): Promise<string | undefined> {
  try {
    const result = await generateLoggedText("continuation-review", settings, {
      ...buildRetryOption(settings),
      prompt: buildContinuationReviewPrompt(draft, context, settingsContext, plan, relatedScenes, extras),
      ...buildTemperatureOption(settings),
      // thinking 系モデルでは推論トークンもこの上限を消費するため、
      // 査読の深さを絞らないよう本体生成と同じ上限を使う。
      maxOutputTokens: Math.min(settings.maxTokens, NONSTREAMING_MAX_OUTPUT_TOKENS),
      abortSignal,
      ...buildAdvancedOptions(settings),
    });

    const reviewText = result.text.trim();
    if (!reviewText) return undefined;
    console.log("[litra] continuation review:", reviewText);
    return reviewText;
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    console.warn("[litra] continuation review step failed; using draft as-is", error);
    return undefined;
  }
}

// 軽量なハッシュ(暗号強度は不要。キャッシュキーの衝突を減らせれば十分)
function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return `${text.length}:${hash}`;
}

interface CachedCard {
  hash: string;
  card: string;
}

// エピソードID(無ければ固定キー)+直前本文末尾のハッシュをキーにキャッシュする。
// 本文が変わらない限り再生成せず、バックグラウンドモデル呼び出しを節約する。
const sceneStateCardCache = new Map<string, CachedCard>();
const characterVoiceCardCache = new Map<string, CachedCard>();

/**
 * 場面ステートカード(提案6)。バックグラウンドモデルで直前本文から場面の状態を整理する。
 * 失敗してもカード無しで続行するため、例外・空文字はここで吸収して undefined を返す(中断だけは伝播)。
 */
async function runSceneStateCardStep(
  settings: AiSettings,
  context: string,
  settingsContext: string | undefined,
  cacheKey: string,
  abortSignal?: AbortSignal,
): Promise<string | undefined> {
  const hash = hashText(`scene-state-v2\n${settings.provider}\n${settings.model}\n${settingsContext ?? ""}\n${context.slice(-2000)}`);
  const persistentKey = `scene-state:${cacheKey}:${settings.provider}:${settings.model}`;
  const cached = sceneStateCardCache.get(cacheKey);
  if (cached && cached.hash === hash) {
    console.log("[litra:ai-step] CACHE HIT scene-state-card", cached.card);
    return cached.card;
  }
  const persisted = await loadPersistentAiArtifact(persistentKey, hash);
  if (persisted) {
    sceneStateCardCache.set(cacheKey, { hash, card: persisted });
    console.log("[litra:ai-step] PERSISTENT CACHE HIT scene-state-card");
    return persisted;
  }

  try {
    const result = await generateLoggedText("scene-state-card", settings, {
      ...buildRetryOption(settings),
      prompt: buildSceneStateCardPrompt(context, settingsContext),
      ...buildTemperatureOption(settings),
      maxOutputTokens: Math.min(settings.maxTokens, NONSTREAMING_MAX_OUTPUT_TOKENS),
      abortSignal,
      ...buildAdvancedOptions(settings),
    });
    const card = result.text.trim();
    if (!card) return undefined;
    sceneStateCardCache.set(cacheKey, { hash, card });
    await savePersistentAiArtifact(persistentKey, hash, card);
    console.log("[litra] scene state card:", card);
    return card;
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    console.warn("[litra] scene state card step failed; continuing without it", error);
    return undefined;
  }
}

/**
 * 話し方カード(提案7)。バックグラウンドモデルで対象人物の一人称・口調等を抽出する。
 * 失敗してもカード無しで続行するため、例外・空文字はここで吸収して undefined を返す(中断だけは伝播)。
 */
async function runCharacterVoiceCardsStep(
  settings: AiSettings,
  names: string[],
  excerpts: string,
  settingsContext: string | undefined,
  cacheKey: string,
  abortSignal?: AbortSignal,
): Promise<string | undefined> {
  const hash = hashText(`character-voice-v2\n${settings.provider}\n${settings.model}\n${settingsContext ?? ""}\n${names.join(",")}\n${excerpts}`);
  const persistentKey = `character-voice:${cacheKey}:${settings.provider}:${settings.model}`;
  const cached = characterVoiceCardCache.get(cacheKey);
  if (cached && cached.hash === hash) {
    console.log("[litra:ai-step] CACHE HIT character-voice-cards", cached.card);
    return cached.card;
  }
  const persisted = await loadPersistentAiArtifact(persistentKey, hash);
  if (persisted) {
    characterVoiceCardCache.set(cacheKey, { hash, card: persisted });
    console.log("[litra:ai-step] PERSISTENT CACHE HIT character-voice-cards");
    return persisted;
  }

  try {
    const result = await generateLoggedText("character-voice-cards", settings, {
      ...buildRetryOption(settings),
      prompt: buildCharacterVoiceCardsPrompt(names, excerpts, settingsContext),
      ...buildTemperatureOption(settings),
      maxOutputTokens: Math.min(settings.maxTokens, NONSTREAMING_MAX_OUTPUT_TOKENS),
      abortSignal,
      ...buildAdvancedOptions(settings),
    });
    const card = result.text.trim();
    if (!card) return undefined;
    characterVoiceCardCache.set(cacheKey, { hash, card });
    await savePersistentAiArtifact(persistentKey, hash, card);
    console.log("[litra] character voice cards:", card);
    return card;
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    console.warn("[litra] character voice cards step failed; continuing without it", error);
    return undefined;
  }
}

/**
 * 候補ドラフト2案の選定ステップ(non-streaming)。
 * 失敗・パース不能時は undefined を返し、呼び出し側で案1を採用させる(中断だけは伝播)。
 */
async function runDraftSelectionStep(
  settings: AiSettings,
  drafts: string[],
  context: string,
  settingsContext: string | undefined,
  plan: string | undefined,
  abortSignal?: AbortSignal,
  scaffold?: PromptScaffoldLevel,
  authorInstruction?: string,
): Promise<number | undefined> {
  try {
    const result = await generateLoggedText("draft-selection", settings, {
      ...buildRetryOption(settings),
      prompt: buildDraftSelectionPrompt(drafts, context, settingsContext, plan, scaffold, authorInstruction),
      ...buildTemperatureOption(settings),
      maxOutputTokens: Math.min(settings.maxTokens, NONSTREAMING_MAX_OUTPUT_TOKENS),
      abortSignal,
      ...buildAdvancedOptions(settings),
    });

    const text = result.text.trim();
    if (!text) return undefined;
    console.log("[litra] draft selection:", text);
    return parseDraftSelection(text, drafts.length);
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    console.warn("[litra] draft selection step failed; using first draft", error);
    return undefined;
  }
}

async function runCandidateSelectionStep(
  settings: AiSettings,
  candidates: string[],
  task: string,
  originalText: string,
  context: string,
  settingsContext?: string,
  abortSignal?: AbortSignal,
  scaffold?: PromptScaffoldLevel,
): Promise<number | undefined> {
  try {
    const result = await generateLoggedText("candidate-selection", settings, {
      ...buildRetryOption(settings),
      prompt: buildCandidateSelectionPrompt(
        candidates,
        task,
        originalText,
        context,
        settingsContext,
        scaffold,
      ),
      ...buildTemperatureOption(settings),
      maxOutputTokens: Math.min(settings.maxTokens, NONSTREAMING_MAX_OUTPUT_TOKENS),
      abortSignal,
      ...buildAdvancedOptions(settings),
    });
    return parseDraftSelection(result.text.trim(), candidates.length);
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    console.warn("[litra] candidate selection failed; using first candidate", error);
    return undefined;
  }
}

/**
 * 置換指示をドラフトへ適用する。各置換は draft.indexOf で一意性を確認し、
 * 見つからない・複数箇所に出現・既に適用した範囲と重複する場合は個別に捨てる。
 */
function applyTargetedReplacements(
  draft: string,
  replacements: Array<{ target: string; replacement: string }>,
): { text: string; appliedCount: number } {
  const applied: Array<{ start: number; end: number; replacement: string }> = [];

  for (const { target, replacement } of replacements) {
    if (!target) continue;
    const firstIndex = draft.indexOf(target);
    if (firstIndex === -1) continue; // 見つからない
    const secondIndex = draft.indexOf(target, firstIndex + 1);
    if (secondIndex !== -1) continue; // 2箇所以上に出現 → 一意でないので捨てる
    const start = firstIndex;
    const end = firstIndex + target.length;
    if (applied.some((a) => start < a.end && end > a.start)) continue; // 範囲の重複 → 捨てる
    applied.push({ start, end, replacement });
  }

  if (applied.length === 0) return { text: draft, appliedCount: 0 };

  applied.sort((a, b) => a.start - b.start);
  let result = "";
  let cursor = 0;
  for (const a of applied) {
    result += draft.slice(cursor, a.start);
    result += a.replacement;
    cursor = a.end;
  }
  result += draft.slice(cursor);
  return { text: result, appliedCount: applied.length };
}

/**
 * スパン限定修正(提案5)。査読の指摘外の文を物理的に保護したまま修正する代替モード。
 * パース不能・全置換が不採用(全滅)の場合は undefined を返し、呼び出し側で
 * 全文修正(buildContinuationRevisionPrompt)へフォールバックさせる(中断だけは伝播)。
 */
async function runTargetedRevisionStep(
  settings: AiSettings,
  draft: string,
  review: string,
  context: string,
  settingsContext: string | undefined,
  extras: FictionPromptExtras | undefined,
  abortSignal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const result = await generateLoggedText("targeted-revision", settings, {
      ...buildRetryOption(settings),
      prompt: buildTargetedRevisionPrompt(draft, review, context, settingsContext, extras),
      ...buildTemperatureOption(settings),
      maxOutputTokens: Math.min(settings.maxTokens, NONSTREAMING_MAX_OUTPUT_TOKENS),
      abortSignal,
      ...buildAdvancedOptions(settings),
    });

    const text = result.text.trim();
    if (!text) return undefined;
    const replacements = parseTargetedRevision(text);
    if (replacements === undefined) return undefined; // 崩れた出力 → フォールバック
    if (replacements.length === 0) {
      console.log("[litra] targeted revision: no replacements needed");
      return draft; // 【置換なし】
    }

    const { text: revised, appliedCount } = applyTargetedReplacements(draft, replacements);
    if (appliedCount === 0) return undefined; // 全滅 → フォールバック
    console.log(`[litra] targeted revision applied ${appliedCount}/${replacements.length} replacements`);
    return revised;
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    console.warn("[litra] targeted revision step failed; falling back to full revision", error);
    return undefined;
  }
}

/**
 * 修正稿の回帰検査。新しい機械的 hard error が残る稿は拒否し、次に判断系モデルで
 * 元稿と修正稿を比較する。選定失敗時は parse の既定位置である元稿を維持する。
 */
async function revisionPassesRegressionGate(
  judgmentSettings: AiSettings,
  original: string,
  revised: string,
  context: string,
  settingsContext: string | undefined,
  abortSignal?: AbortSignal,
): Promise<boolean> {
  const sanitized = sanitizeDraftText(revised);
  if (!sanitized.trim()) return false;

  const revisedChecks = checkDraft(sanitized, context);
  if (revisedChecks.hard.length > 0) {
    console.warn("[litra] revision regression gate rejected hard violations", revisedChecks.hard);
    return false;
  }

  const selected = await runCandidateSelectionStep(
    judgmentSettings,
    [original, sanitized],
    "同じ査読を踏まえた完成稿の回帰比較。欠陥の解消だけでなく、元稿の長所、文体、リズム、含意が失われていない案",
    original,
    context,
    settingsContext,
    abortSignal,
    judgmentSettings.promptScaffold,
  );
  if (selected !== 1) {
    console.warn("[litra] revision regression gate kept original draft");
    return false;
  }
  return true;
}

/**
 * ペン入れ第1工程 — 編集者の査読(判断系モデル)。
 * プロンプトは buildLineEditReviewPrompt で、出力形式は続き生成のレビューと同じ。
 * 失敗時は undefined を返す。
 */
export async function runLineEditReview(
  settings: AiSettings,
  passage: string,
  context: string,
  settingsContext?: string,
  instruction?: string,
  extras?: FictionPromptExtras,
  abortSignal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const result = await generateLoggedText("line-edit-review", settings, {
      ...buildRetryOption(settings),
      prompt: buildLineEditReviewPrompt(passage, context, settingsContext, instruction, extras),
      ...buildTemperatureOption(settings),
      maxOutputTokens: Math.min(settings.maxTokens, NONSTREAMING_MAX_OUTPUT_TOKENS),
      abortSignal,
      ...buildAdvancedOptions(settings),
    });
    const reviewText = result.text.trim();
    if (!reviewText) return undefined;
    return reviewText;
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    console.warn("[litra] line edit review step failed", error);
    return undefined;
  }
}

/**
 * ペン入れ第2工程 — 査読に基づく置換案生成(執筆系モデル)。
 * プロンプトは buildLineEditRevisionPrompt で、出力形式は続き生成のスパン限定修正と同一。
 * buildLineEditRevisionPrompt から parseTargetedRevision で読める置換案を生成する。
 * 失敗時は undefined を返す。
 */
export async function runLineEditRevision(
  settings: AiSettings,
  passage: string,
  review: string,
  context: string,
  settingsContext?: string,
  instruction?: string,
  extras?: FictionPromptExtras,
  abortSignal?: AbortSignal,
  judgmentSettings?: AiSettings,
  onProgress?: (stage: "candidate-1" | "candidate-2" | "selection") => void,
): Promise<string | undefined> {
  try {
    const generateCandidate = async (stage: "candidate-1" | "candidate-2"): Promise<string> => {
      onProgress?.(stage);
      const result = await generateLoggedText(`line-edit-${stage}`, settings, {
        ...buildRetryOption(settings),
        prompt: buildLineEditRevisionPrompt(passage, review, context, settingsContext, instruction, extras),
        ...buildTemperatureOption(settings),
        maxOutputTokens: Math.min(settings.maxTokens, NONSTREAMING_MAX_OUTPUT_TOKENS),
        abortSignal,
        ...buildAdvancedOptions(settings),
      });
      return result.text.trim();
    };
    const first = await generateCandidate("candidate-1");
    if (!first) return undefined;
    if (!settings.continuationBestOfTwo || !judgmentSettings) return first;
    const second = await generateCandidate("candidate-2");
    if (!second) return first;
    const validCandidates = [first, second].filter(
      (candidate) => parseTargetedRevision(candidate) !== undefined,
    );
    if (validCandidates.length === 0) return first;
    if (validCandidates.length === 1) return validCandidates[0];
    onProgress?.("selection");
    const selected = await runCandidateSelectionStep(
      judgmentSettings,
      validCandidates,
      "査読に基づく局所的な修正案",
      passage,
      context,
      settingsContext,
      abortSignal,
      judgmentSettings.promptScaffold,
    );
    return validCandidates[selected ?? 0] ?? validCandidates[0];
  } catch (error) {
    if (abortSignal?.aborted) throw error;
    console.warn("[litra] line edit revision step failed", error);
    return undefined;
  }
}

export async function streamContinuation({
  settings,
  context,
  onChunk,
  abortSignal,
  settingsContext,
  relatedScenes,
  tools,
  onToolEvent,
  onReasoning,
  onStage,
  getJudgmentSettings,
  styleFingerprint,
  episodeId,
  characterVoiceInput,
  authorInstruction,
}: StreamContinuationOptions): Promise<StreamRunResult> {
  try {
    const s = normalizeSettings(settings);
    const scopedTools = scopeContinuationTools(tools);
    const toolsEnabled = hasTools(scopedTools);
    const toolNames = toolsEnabled ? Object.keys(scopedTools) : [];
    // 執筆系の足場レベルを extras 経由でドラフト・修正系プロンプトへ伝える。
    let extras: FictionPromptExtras | undefined = s.promptScaffold
      ? { promptScaffold: s.promptScaffold }
      : undefined;
    if (styleFingerprint) extras = { ...extras, styleFingerprint };
    if (authorInstruction?.trim()) extras = { ...extras, authorInstruction };

    // 構想・レビューは出力が短く「判断」寄りの工程のため、判断系モデルに振る。
    // source の判定(本文/バックグラウンド/カスタム)は main.ts 側が担う。
    const judgmentSettings = getJudgmentSettings ? normalizeSettings(getJudgmentSettings()) : s;
    const reportStage = (stage: "plan" | "draft" | "review" | "revise" | "regression"): void => {
      const stageSettings = stage === "plan" || stage === "review" || stage === "regression"
        ? judgmentSettings
        : s;
      console.log(`[litra:pipeline] STAGE ${stage}`, {
        provider: stageSettings.provider,
        model: stageSettings.model,
      });
      onStage?.(stage);
    };

    const cacheKeyBase = episodeId ?? "__no_episode__";

    if (s.continuationSceneStateEnabled) {
      const sceneState = await runSceneStateCardStep(judgmentSettings, context, settingsContext, cacheKeyBase, abortSignal);
      if (sceneState) extras = { ...extras, sceneState };
    }

    if (s.continuationCharacterVoiceEnabled && characterVoiceInput && characterVoiceInput.names.length > 0) {
      const characterVoiceCards = await runCharacterVoiceCardsStep(
        judgmentSettings,
        characterVoiceInput.names,
        characterVoiceInput.excerpts,
        settingsContext,
        cacheKeyBase,
        abortSignal,
      );
      if (characterVoiceCards) extras = { ...extras, characterVoiceCards };
    }

    if (s.twoStageContinuation) reportStage("plan");
    const plan = s.twoStageContinuation
      ? await runContinuationPlanStep(
          judgmentSettings,
          context,
          settingsContext,
          relatedScenes,
          abortSignal,
          authorInstruction,
        )
      : undefined;

    reportStage("draft");
    const reviewEnabled = s.continuationReviewEnabled === true;
    const bestOfTwo = s.continuationBestOfTwo === true;

    // 設定資料は system ではなく本文プロンプト側に注入する(弱いモデルの recency 対策)
    let draftGenerationSequence = 0;
    const runDraftGeneration = async (
      draftContext: string,
      draftExtras: FictionPromptExtras | undefined,
      onDraftChunk: (chunk: string) => void,
    ): Promise<{ text: string; run: StreamRunResult }> => {
      const generationId = ++draftGenerationSequence;
      let cumulativeContext = draftContext;
      let text = "";
      let combinedRun: StreamRunResult | undefined;

      for (let attempt = 0; attempt <= CONTINUATION_LENGTH_RETRY_LIMIT; attempt++) {
        const draftStep = beginAiStep(`continuation-draft-${generationId}-segment-${attempt + 1}`, s);
        const draftResult = streamText<ToolSet>({
          model: createModel(s),
          ...buildRetryOption(s),
          system: buildAssistantSystemPrompt({ toolsEnabled, toolNames }),
          prompt: buildContinuationPrompt(cumulativeContext, settingsContext, plan, relatedScenes, draftExtras),
          ...buildTemperatureOption(s),
          maxOutputTokens: s.maxTokens,
          abortSignal,
          tools: scopedTools,
          stopWhen: toolsEnabled ? toolLoopStopConditions() : undefined,
          ...buildAdvancedOptions(s),
        });
        let segmentText = "";
        const segmentRun = await consumeStream(
          draftResult,
          (chunk) => {
            segmentText += chunk;
            onDraftChunk(chunk);
          },
          onToolEvent,
          onReasoning,
          { step: `continuation-draft-segment-${attempt + 1}`, settings: s },
        );
        completeAiStep(draftStep, segmentText, segmentRun.finishReason);
        text += segmentText;
        combinedRun = combinedRun ? mergeToolStats(combinedRun, segmentRun) : segmentRun;

        if (segmentRun.finishReason !== "length" || !segmentText.trim()) break;
        if (attempt === CONTINUATION_LENGTH_RETRY_LIMIT) {
          console.warn("[litra] continuation length retry limit reached");
          break;
        }
        console.warn("[litra] continuation hit maxOutputTokens; auto-continuing", { attempt: attempt + 1 });
        const continuationContextBudget = Math.max(
          BEAT_CONTEXT_CHAR_BUDGET,
          Math.floor(Math.max(4096, s.maxContextTokens - s.maxTokens - 2048) * 2.5),
        );
        cumulativeContext = limitPromptText(
          `${draftContext}${text}`,
          continuationContextBudget,
          "tail",
        );
      }

      return { text, run: combinedRun! };
    };

    const noop = (_chunk: string): void => {};
    const mergeToolStats = (a: StreamRunResult, b: StreamRunResult): StreamRunResult => ({
      // 終了理由・レスポンス情報は最後の区間を採用し、件数だけを累積する。
      ...b,
      textChunkCount: a.textChunkCount + b.textChunkCount,
      textCharCount: a.textCharCount + b.textCharCount,
      reasoningChunkCount: a.reasoningChunkCount + b.reasoningChunkCount,
      reasoningCharCount: a.reasoningCharCount + b.reasoningCharCount,
      toolCallCount: a.toolCallCount + b.toolCallCount,
      toolResultCount: a.toolResultCount + b.toolResultCount,
      toolErrorCount: a.toolErrorCount + b.toolErrorCount,
      pendingToolCallIds: [...new Set([...a.pendingToolCallIds, ...b.pendingToolCallIds])],
      responseMessages: [...a.responseMessages, ...b.responseMessages],
    });

    let draftText: string;
    let draftRun: StreamRunResult;

    if (bestOfTwo) {
      // 候補2案は選定が決まるまでエディタへ流さず、両方バッファする。
      const candidateA = await runDraftGeneration(context, extras, noop);
      const candidateB = await runDraftGeneration(context, extras, noop);
      const candidates = [candidateA, candidateB];
      const selectedIndex = await runDraftSelectionStep(
        judgmentSettings,
        candidates.map((c) => c.text),
        context,
        settingsContext,
        plan,
        abortSignal,
        judgmentSettings.promptScaffold,
        authorInstruction,
      );
      const chosen = candidates[selectedIndex ?? 0] ?? candidateA;
      draftText = chosen.text;
      draftRun = {
        ...chosen.run,
        toolCallCount: candidateA.run.toolCallCount + candidateB.run.toolCallCount,
        toolResultCount: candidateA.run.toolResultCount + candidateB.run.toolResultCount,
        toolErrorCount: candidateA.run.toolErrorCount + candidateB.run.toolErrorCount,
      };
      if (!reviewEnabled) {
        onChunk(draftText);
        return draftRun;
      }
    } else {
      // レビューON・ビート分割時はドラフトをエディタへ直接流さず、いったんバッファへ溜める
      // (レビューで修正が必要と判定された場合は破棄し、修正稿だけを流すため)。
      const emit = reviewEnabled ? noop : onChunk;
      const beats = s.continuationBeatSplitEnabled && plan ? parsePlanBeats(plan) : [];

      if (beats.length >= 2) {
        // ビート分割生成: 各ビートを順に生成し、前ビートの生成分を文脈に継ぎ足す。
        // 途中のビートで失敗した場合、それまでの分は emit 済みなので維持し、エラーは伝播する。
        let cumulativeContext = context;
        let combinedText = "";
        let combinedRun: StreamRunResult | undefined;
        for (let i = 0; i < beats.length; i++) {
          const beatExtras: FictionPromptExtras = {
            ...extras,
            beatDirective: { beat: beats[i], index: i + 1, total: beats.length },
          };
          const beatResult = await runDraftGeneration(cumulativeContext, beatExtras, emit);
          combinedText += beatResult.text;
          cumulativeContext = limitPromptText(`${cumulativeContext}${beatResult.text}`, BEAT_CONTEXT_CHAR_BUDGET, "tail");
          combinedRun = combinedRun ? mergeToolStats(combinedRun, beatResult.run) : beatResult.run;
        }
        draftText = combinedText;
        draftRun = combinedRun!;
      } else {
        const single = await runDraftGeneration(context, extras, emit);
        draftText = single.text;
        draftRun = single.run;
      }
      if (!reviewEnabled) return draftRun;
    }

    if (!draftText.trim()) return draftRun; // ドラフトが空なら何もしない(フォールバックする本文が無い)

    // 決定論的な機械検査(提案4)。LLM を使わず判断はコード側で完結させる。
    draftText = sanitizeDraftText(draftText);
    let checks = checkDraft(draftText, context);
    if (checks.hard.length > 0) {
      console.warn("[litra] draft check found hard violations; retrying draft once", checks.hard);
      const retry = await runDraftGeneration(context, { ...extras, mechanicalFindings: checks.hard }, noop);
      if (retry.text.trim()) {
        draftText = sanitizeDraftText(retry.text);
        draftRun = {
          ...retry.run,
          toolCallCount: retry.run.toolCallCount + draftRun.toolCallCount,
          toolResultCount: retry.run.toolResultCount + draftRun.toolResultCount,
          toolErrorCount: retry.run.toolErrorCount + draftRun.toolErrorCount,
        };
        // 無限リトライを避けるため2回目はチェックし直すだけで、違反が残っても軽違反として査読へ回す
        checks = checkDraft(draftText, context);
      }
    }
    const mechanicalFindings = [...checks.hard, ...checks.soft];

    reportStage("review");
    let review = await runContinuationReviewStep(
      judgmentSettings,
      draftText,
      context,
      settingsContext,
      plan,
      relatedScenes,
      abortSignal,
      { ...extras, promptScaffold: judgmentSettings.promptScaffold },
    );
    if (mechanicalFindings.length > 0) {
      const mechanicalBlock = formatMechanicalFindingsForReview(mechanicalFindings);
      review = review ? `${review}\n\n${mechanicalBlock}` : mechanicalBlock;
    }
    const needsRevision = mechanicalFindings.length > 0 || (review !== undefined && reviewRequiresRevision(review));
    if (!review || !needsRevision) {
      onChunk(draftText); // レビュー失敗 or 問題なし → ドラフトをそのまま一括出力
      return draftRun;
    }

    reportStage("revise");

    if (s.continuationTargetedRevision) {
      const targeted = await runTargetedRevisionStep(s, draftText, review, context, settingsContext, extras, abortSignal);
      if (targeted !== undefined) {
        reportStage("regression");
        if (targeted === draftText || await revisionPassesRegressionGate(
          judgmentSettings,
          draftText,
          targeted,
          context,
          settingsContext,
          abortSignal,
        )) {
          onChunk(targeted);
          return draftRun;
        }
        // 回帰検査で不合格なら、より広い修正が必要な可能性を考慮して全文修正を一度試す。
      }
      // undefined → 崩れた出力 or 全滅。以下の全文修正へフォールバックする。
    }

    try {
      const revisionStep = beginAiStep("full-revision", s);
      const revisionResult = streamText<ToolSet>({
        model: createModel(s),
        ...buildRetryOption(s),
        system: buildAssistantSystemPrompt({ toolsEnabled: false }),
        prompt: buildContinuationRevisionPrompt(draftText, review, context, settingsContext, relatedScenes, extras),
        ...buildTemperatureOption(s),
        maxOutputTokens: s.maxTokens,
        abortSignal,
        ...buildAdvancedOptions(s),
      });
      let revisedText = "";
      const revisionRun = await consumeStream(
        revisionResult,
        (chunk) => {
          revisedText += chunk;
        },
        undefined,
        onReasoning,
        { step: "continuation-full-revision", settings: s },
      );
      revisedText = sanitizeDraftText(revisedText);
      completeAiStep(revisionStep, revisedText, revisionRun.finishReason);
      reportStage("regression");
      const accepted = await revisionPassesRegressionGate(
        judgmentSettings,
        draftText,
        revisedText,
        context,
        settingsContext,
        abortSignal,
      );
      onChunk(accepted ? revisedText : draftText);
      // main.ts の finalizeToolRun がツール実行数を表示に使うため、
      // ドラフト段のツール集計を最終 run に引き継ぐ
      return {
        ...revisionRun,
        toolCallCount: revisionRun.toolCallCount + draftRun.toolCallCount,
        toolResultCount: revisionRun.toolResultCount + draftRun.toolResultCount,
        toolErrorCount: revisionRun.toolErrorCount + draftRun.toolErrorCount,
      };
    } catch (error) {
      if (abortSignal?.aborted) throw error;
      // 修正稿は回帰検査が終わるまでバッファするため、失敗時に部分稿は露出しない。
      console.warn("[litra] continuation revision step failed; using draft as-is", error);
      onChunk(draftText);
      return draftRun;
    }
  } catch (error) {
    console.error("streamContinuation error:", error);
    throw error;
  }
}

export async function streamRewrite({
  settings,
  selection,
  context,
  onChunk,
  abortSignal,
  settingsContext,
  onReasoning,
  instruction,
  judgmentSettings,
}: StreamRewriteOptions): Promise<StreamRunResult> {
  try {
    const s = normalizeSettings(settings);
    const runCandidate = async (emit: (chunk: string) => void): Promise<{ text: string; run: StreamRunResult }> => {
      let text = "";
      const result = await streamRustText(s, {
        system: buildAssistantSystemPrompt({ toolsEnabled: false }),
        prompt: buildRewritePrompt(selection, context, settingsContext, s.promptScaffold, instruction),
        maxOutputTokens: s.maxTokens,
        abortSignal,
        onChunk: (chunk) => { text += chunk; emit(chunk); },
        onReasoning,
      });
      return {
        text: sanitizeDraftText(text),
        run: rustTextResultToRunResult(result, text),
      };
    };

    if (!s.continuationBestOfTwo || !judgmentSettings) {
      const single = await runCandidate(onChunk);
      return single.run;
    }

    const first = await runCandidate(() => {});
    const second = await runCandidate(() => {});
    const selected = await runCandidateSelectionStep(
      normalizeSettings(judgmentSettings),
      [first.text, second.text],
      "指定範囲の書き直し案",
      selection,
      context,
      settingsContext,
      abortSignal,
      judgmentSettings.promptScaffold,
    );
    const chosen = [first, second][selected ?? 0] ?? first;
    onChunk(chosen.text);
    return {
      ...chosen.run,
      toolCallCount: first.run.toolCallCount + second.run.toolCallCount,
      toolResultCount: first.run.toolResultCount + second.run.toolResultCount,
      toolErrorCount: first.run.toolErrorCount + second.run.toolErrorCount,
    };
  } catch (error) {
    console.error("streamRewrite error:", error);
    throw error;
  }
}

export async function streamFeedback({
  settings,
  selection,
  onChunk,
  abortSignal,
  settingsContext,
  onReasoning,
}: StreamFeedbackOptions): Promise<StreamRunResult> {
  try {
    const s = normalizeSettings(settings);
    const result = await streamRustText(s, {
      system: buildAssistantSystemPrompt({ toolsEnabled: false }),
      prompt: buildFeedbackPrompt(selection, settingsContext),
      maxOutputTokens: s.maxTokens,
      abortSignal,
      onChunk,
      onReasoning,
    });
    return rustTextResultToRunResult(result);
  } catch (error) {
    console.error("streamFeedback error:", error);
    throw error;
  }
}
