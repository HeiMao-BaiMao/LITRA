import type { AiSettings } from "../settings.ts";
import { getModelCapability } from "./capability.ts";
import type { ProviderModelDefaults } from "../providers/config.ts";

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

/**
 * Gemini 3 系（gemini-3 / gemini-3.1 / gemini-3.5 ...）かどうかを判定する。
 */
export function isGemini3Model(model: string): boolean {
  return /^gemini-3(\.|-|$)/.test(model);
}

/**
 * モデルの capability を考慮してプロバイダーオプションを構築する。
 * 選択されたモデルの reasoningCapability メタデータを参照し、
 * サポートされているオプションのみをプロトコルに送出する。
 * 非対応のフィールド（例: adaptive-only モデルへの budget）は送らない。
 *
 * @param settings 現在の AI 設定
 * @param _toolsEnabled 旧仕様の名残(DeepSeek thinking がツールと両立するため未使用。互換のため残置)
 * @param defaults 選択されたモデルの ProviderModelDefaults（reasoningCapability を含む）
 */
export function buildProviderOptions(
  settings: AiSettings,
  _toolsEnabled = false,
  defaults?: ProviderModelDefaults,
): Record<string, Record<string, JSONValue>> | undefined {
  const provider = settings.provider;
  const modelId = settings.model;

  // Use ephemeral reasoningCapability from settings if available, otherwise resolve from defaults
  const cap = settings.reasoningCapability ?? getModelCapability(provider, modelId, defaults);

  switch (provider) {
    case "openai": {
      if (!settings.openaiReasoningEffort) return undefined;
      const baseUrl = typeof settings.baseUrl === "string" ? settings.baseUrl.trim() : "";
      if (baseUrl.includes("api.platform.preferredai.jp")) return undefined;
      return {
        openai: {
          // GPT-5.1 以降 "minimal" は API から削除済み("none" が後継)。旧設定を救済する。
          reasoningEffort: settings.openaiReasoningEffort === "minimal" ? "none" : settings.openaiReasoningEffort,
          // "detailed" はモデルスナップショットによって拒否された実績があるため公式推奨の "auto" を使う
          reasoningSummary: "auto",
        },
      };
    }
    case "anthropic": {
      if (!cap) {
        // capability 不明のモデルには従来どおり effort 設定時のみ adaptive を送る
        if (!settings.anthropicThinkingEffort) return undefined;
        return {
          anthropic: {
            thinking: { type: "adaptive" },
            effort: settings.anthropicThinkingEffort,
          },
        };
      }
      if (cap.kind === "anthropic-adaptive") {
        // Opus 4.8 のような「adaptive だが無効化可」のモデルでは、無効時に
        // thinking を一切送らない(省略 = OFF。{type:"disabled"} は Fable 5 で 400)。
        if (cap.canDisable === true && settings.anthropicThinkingEnabled === false) {
          return undefined;
        }
        // Fable 5 のような常時 ON adaptive モデルは、effort を指定しない場合でも
        // thinking 自体はサーバ側で有効になるため providerOptions を省略する。
        if (cap.canDisable !== true && !settings.anthropicThinkingEffort) {
          return undefined;
        }
        // Never emit invented display:"detailed"; only emit display when metadata says "summarized"
        const thinking: Record<string, JSONValue> = { type: "adaptive" };
        if (cap.display === "summarized") {
          thinking.display = "summarized";
        }
        return {
          anthropic: {
            thinking,
            ...(settings.anthropicThinkingEffort && { effort: settings.anthropicThinkingEffort }),
          },
        };
      }
      // Budget thinking supports explicit disable. Only enabled mode needs a budget.
      if (settings.anthropicThinkingEnabled === false) {
        return { anthropic: { thinking: { type: "disabled" } } };
      }
      if (settings.anthropicThinkingBudget == null) return undefined;
      return {
        anthropic: {
          thinking: {
            type: "enabled",
            budgetTokens: settings.anthropicThinkingBudget,
          },
        },
      };
    }
    case "deepseek": {
      // DeepSeek V3.2 以降、thinking モードはツール呼び出しと両立する。
      // ON/OFF は設定のみで決める(ツール有効時の強制 OFF は V3 時代の制約)。
      if (settings.deepseekThinkingEnabled === false) {
        return { deepseek: { thinking: { type: "disabled" } } };
      }
      const options: Record<string, JSONValue> = {
        thinking: { type: "enabled" },
      };
      // API の有効値は "high" / "max" のみ。それ以外はサーバ既定(high)に任せる。
      if (settings.deepseekReasoningEffort === "high" || settings.deepseekReasoningEffort === "max") {
        options.reasoningEffort = settings.deepseekReasoningEffort;
      }
      return { deepseek: options };
    }
    case "codex": {
      const effort = settings.openaiReasoningEffort === "minimal" ? "none" : settings.openaiReasoningEffort;
      return {
        openai: {
          ...(effort && { reasoningEffort: effort }),
          reasoningSummary: "auto",
          // Codex backend はサーバ側に会話状態を持たない。store:false と
          // encrypted reasoning の往復が無いとマルチターンのツール呼び出しが
          // 2 ターン目に 400 ("reasoning without its required following item") になる。
          store: false,
          include: ["reasoning.encrypted_content"],
        },
      };
    }
    case "github-copilot": {
      // Use the same effective capability that drove the UI/model routing. The
      // runtime places the authenticated Copilot cache override on settings.
      if (cap?.kind === "anthropic-adaptive") {
        if (!settings.anthropicThinkingEffort) return undefined;
        const thinking: Record<string, JSONValue> = { type: "adaptive" };
        if (cap.display === "summarized") thinking.display = "summarized";
        return { anthropic: { thinking, effort: settings.anthropicThinkingEffort } };
      }
      if (cap?.kind === "anthropic-budget") {
        if (settings.anthropicThinkingEnabled === false) {
          return { anthropic: { thinking: { type: "disabled" } } };
        }
        if (settings.anthropicThinkingBudget == null) return undefined;
        return { anthropic: { thinking: { type: "enabled", budgetTokens: settings.anthropicThinkingBudget } } };
      }
      if (cap?.kind === "openai") {
        if (!settings.openaiReasoningEffort) return undefined;
        return {
          openai: {
            reasoningEffort: settings.openaiReasoningEffort,
            reasoningSummary: "auto",
            include: ["reasoning.encrypted_content"],
          },
        };
      }
      return undefined;
    }
    case "sakura":
      // Sakura の Responses API はマルチターン非対応のため Chat Completions を使う。
      // store / strictJsonSchema / reasoningSummary は Responses 専用なので送らない。
      return {
        openai: {
          parallelToolCalls: false,
        },
      };
    case "google": {
      if (!isGemini3Model(settings.model)) return undefined;
      // thinkingLevel の有効値はモデル別(gemini-3.1-pro 系は "minimal" 非対応)。
      // capability の supportedEfforts に無い値は "minimal"→"low" に格上げし、
      // それでも不一致なら送らずサーバ既定に任せる。
      let level = settings.googleThinkingLevel;
      const supported = cap?.kind === "google" ? cap.supportedEfforts : undefined;
      if (level && Array.isArray(supported) && !supported.includes(level)) {
        const fallback = level === "minimal" ? "low" : undefined;
        level = fallback && supported.includes(fallback) ? fallback : undefined;
      }
      return {
        google: {
          thinkingConfig: {
            includeThoughts: true,
            ...(level ? { thinkingLevel: level } : {}),
          },
        },
      };
    }
    default:
      return undefined;
  }
}

/**
 * debugFetch が独自のリトライ（カスタムバックオフ）を行うプロバイダでは
 * AI SDK の標準リトライを無効化し、二重リトライによる過剰な待ち時間を防ぐ。
 */
export function buildRetryOption(settings: AiSettings): { maxRetries?: number } {
  if (
    settings.provider === "opencode" ||
    settings.provider === "sakura" ||
    settings.provider === "codex" ||
    settings.provider === "github-copilot"
  ) {
    return { maxRetries: 0 };
  }
  return {};
}

/**
 * AI 呼び出しのエラーメッセージをユーザー向けに整形する。
 */
export function formatAiErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (
    /upstream request failed|upstream error|upstream unavailable|overloaded|temporarily unavailable|service unavailable|rate[- ]?limit|too many requests|throttl/i.test(
      raw,
    )
  ) {
    return `${raw}\n\n時間をおいて再度送信してください。`;
  }
  return raw;
}
