/**
 * モデルの推論/思考能力を解決するためのモジュール。
 * ProviderModelDefaults の reasoningCapability メタデータを参照し、
 * UI が表示すべきコントロールや buildProviderOptions が送信すべき
 * プロトコルオプションを決定する。
 */

import type {
  ProviderModelDefaults,
  ReasoningCapability,
} from "../providers/config.ts";
import type { Provider } from "../settings.ts";

/// Anthropic 適応的思考で使用可能な effort 値。
export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

/// アプリ全体で使う thinking/reasoning の抽象設定値。
export type ThinkingEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * モデルの capability メタデータを取得する。
 * ProviderModelDefaults の reasoningCapability が存在すればそれを返す。
 * 無い場合は provider と model ID から類推する（フォールバック）。
 * defaults を渡すと curated メタデータを優先する。
 */
export function getModelCapability(
  provider: Provider,
  modelId: string,
  defaults?: ProviderModelDefaults,
): ReasoningCapability | undefined {
  if (defaults?.reasoningCapability) {
    return defaults.reasoningCapability;
  }

  // フォールバック: プロバイダとモデル名から推論
  if (provider === "anthropic") {
    if (modelId === "claude-fable-5") {
      return { kind: "anthropic-adaptive", supportedEfforts: ["low", "medium", "high", "xhigh", "max"], display: "summarized" };
    }
    if (modelId.startsWith("claude-opus-4-7") || modelId.startsWith("claude-opus-4-8")) {
      return {
        kind: "anthropic-adaptive",
        supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
        display: "summarized",
        canDisable: true,
      };
    }
    if (modelId.startsWith("claude-")) {
      return { kind: "anthropic-budget", canDisable: true, supportsBudget: true };
    }
  }

  if (provider === "deepseek") {
    // reasoning_effort の有効値は "high"/"max" のみ(それ以外はサーバ既定 high に任せる)
    return { kind: "deepseek", supportedEfforts: ["high", "max"], canDisable: true };
  }

  if (provider === "google" && /^gemini-3(\.|-|$)/.test(modelId)) {
    // gemini-3.1-pro 系は thinkingLevel に "minimal" 非対応
    if (modelId.startsWith("gemini-3.1-pro")) {
      return { kind: "google", supportedEfforts: ["low", "medium", "high"] };
    }
    return { kind: "google", supportedEfforts: ["minimal", "low", "medium", "high"] };
  }

  if (provider === "openai" || provider === "codex") {
    // GPT-5.1 以降 "minimal" は廃止("none" が後継)
    return { kind: "openai", supportedEfforts: ["none", "low", "medium", "high", "xhigh"] };
  }

  if (provider === "github-copilot") {
    if (modelId.startsWith("claude-fable-5")) {
      return { kind: "anthropic-adaptive", supportedEfforts: ["low", "medium", "high"], display: "summarized" };
    }
    if (modelId.startsWith("claude-opus-4-7") || modelId.startsWith("claude-opus-4-8")) {
      return {
        kind: "anthropic-adaptive",
        supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
        display: "summarized",
        canDisable: true,
      };
    }
    if (modelId.startsWith("claude-")) {
      return { kind: "anthropic-budget", canDisable: true, supportsBudget: true };
    }
    if (/^gpt-5/.test(modelId)) {
      // GPT-5.1 以降 "minimal" は廃止("none" が後継)
      return { kind: "openai", supportedEfforts: ["none", "low", "medium", "high", "xhigh"] };
    }
  }

  if (provider === "opencode") {
    if (modelId === "deepseek-v4-flash" || modelId === "deepseek-v4-pro") {
      return undefined;
    }
    if (modelId === "minimax-m3" || modelId.startsWith("qwen3.")) {
      return undefined;
    }
  }

  return undefined;
}

/**
 * Copilot キャッシュエントリの能力情報を ReasoningCapability に変換する。
 * キャッシュが無いか不完全な場合は undefined を返す。
 */
export function copilotCacheToCapability(
  cacheEntry: { endpoint: string; reasoningEffort?: string[]; adaptiveThinking?: boolean; minThinkingBudget?: number; maxThinkingBudget?: number } | undefined,
): ReasoningCapability | undefined {
  if (!cacheEntry) return undefined;

  if (cacheEntry.endpoint === "messages") {
    if (cacheEntry.adaptiveThinking) {
      return {
        kind: "anthropic-adaptive",
        supportedEfforts: cacheEntry.reasoningEffort ?? ["low", "medium", "high"],
        display: "summarized",
      };
    }
    if (cacheEntry.maxThinkingBudget != null) {
      return {
        kind: "anthropic-budget",
        canDisable: true,
        supportsBudget: true,
        minBudget: cacheEntry.minThinkingBudget,
        maxBudget: cacheEntry.maxThinkingBudget,
      };
    }
  }

  if (cacheEntry.endpoint === "responses" && cacheEntry.reasoningEffort) {
    return {
      kind: "openai",
      supportedEfforts: cacheEntry.reasoningEffort,
    };
  }

  return undefined;
}

/**
 * 有効なモデル能力を解決する。
 * 優先順位:
 * 1. Copilot キャッシュエントリ（getCachedEntry が提供され、それを優先する）
 * 2. ProviderModelDefaults の curated reasoningCapability
 * 3. フォールバック（モデル名ベースの類推）
 *
 * getCachedEntry は同期 Copilot キャッシュルックアップ関数。
 * 呼び出し側は settings-modal.ts 等から getCopilotModelCacheEntry を渡す。
 * 渡さない場合はキャッシュ参照をスキップする。
 */
export function getEffectiveCapability(
  provider: Provider,
  modelId: string,
  defaults?: ProviderModelDefaults,
  getCachedEntry?: (id: string) => { endpoint: string; reasoningEffort?: string[]; adaptiveThinking?: boolean; minThinkingBudget?: number; maxThinkingBudget?: number } | undefined,
): ReasoningCapability | undefined {
  // Copilot キャッシュが存在すればそれを最優先
  if (provider === "github-copilot" && getCachedEntry) {
    const cacheEntry = getCachedEntry(modelId);
    const cached = copilotCacheToCapability(cacheEntry);
    if (cached) return cached;
  }

  return getModelCapability(provider, modelId, defaults);
}

/**
 * 指定されたモデルが reasoning/thinking をサポートするかどうかを返す。
 */
export function modelSupportsReasoning(cap?: ReasoningCapability): boolean {
  if (!cap) return false;
  return true;
}

/**
 * 指定されたモデルで thinking を無効化できるかどうかを返す。
 * anthropic-adaptive は常時有効のため false。
 */
export function canDisableThinking(cap?: ReasoningCapability): boolean {
  return cap?.canDisable === true;
}

/**
 * reasoning/thinking が常時有効かどうかを返す。
 * anthropic-adaptive は原則常時有効(Fable 5 は thinking パラメータ省略が 400 になるため
 * 常時 ON)だが、Opus 4.8 のように canDisable: true な adaptive モデルは切替可能なため
 * 常時有効とはみなさない。
 */
export function isThinkingAlwaysOn(cap?: ReasoningCapability): boolean {
  return cap?.kind === "anthropic-adaptive" && cap.canDisable !== true;
}

/**
 * モデルが effort 選択をサポートするかどうか。
 */
export function supportsEffortSelector(cap?: ReasoningCapability): boolean {
  if (!cap) return false;
  const { kind, supportedEfforts } = cap;
  if (kind === "google") return false;
  return Array.isArray(supportedEfforts) && supportedEfforts.length > 0;
}

/**
 * モデルが budget 入力をサポートするかどうか。
 */
export function supportsBudgetInput(cap?: ReasoningCapability): boolean {
  return cap?.supportsBudget === true;
}

/**
 * 表示すべき UI コントロールの種別を返す。
 */
export type ControlType = "none" | "openai-reasoning-effort" | "anthropic-adaptive" | "anthropic-budget" | "deepseek" | "google-thinking-level";

export function getControlType(cap?: ReasoningCapability): ControlType {
  if (!cap) return "none";
  switch (cap.kind) {
    case "openai": return "openai-reasoning-effort";
    case "anthropic-adaptive": return "anthropic-adaptive";
    case "anthropic-budget": return "anthropic-budget";
    case "deepseek": return "deepseek";
    case "google": return "google-thinking-level";
    default: return "none";
  }
}

/**
 * モデルがサポートする effort 値の一覧を返す。
 */
export function getSupportedEfforts(cap?: ReasoningCapability): string[] {
  if (!cap?.supportedEfforts) return [];
  return cap.supportedEfforts;
}

/**
 * コントロールを非表示（hidden）にすべきかを返す。
 */
export function shouldHideControls(cap?: ReasoningCapability): boolean {
  return cap === undefined;
}
