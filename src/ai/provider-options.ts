import type { AiSettings } from "../settings.ts";

type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };

/**
 * Gemini 3 系（gemini-3 / gemini-3.1 / gemini-3.5 ...）かどうかを判定する。
 * Gemini 3 系は temperature/topP/topK ではなく thinkingConfig.thinkingLevel で
 * 思考の深さを制御する仕様に変わっており、Gemma 系（従来通り sampling params を使う）
 * とは扱いを分ける必要がある。
 */
export function isGemini3Model(model: string): boolean {
  return /^gemini-3(\.|-|$)/.test(model);
}

export function buildProviderOptions(
  settings: AiSettings,
  toolsEnabled = false,
): Record<string, Record<string, JSONValue>> | undefined {
  switch (settings.provider) {
    case "openai": {
      if (!settings.openaiReasoningEffort) return undefined;
      // PLaMo は /v1/responses に対応していないため、reasoningEffort を渡すと 404 になる。
      // 他の OpenAI 互換サービスは responses に対応している可能性があるので、PLaMo だけ除外する。
      const baseUrl = typeof settings.baseUrl === "string" ? settings.baseUrl.trim() : "";
      if (baseUrl.includes("api.platform.preferredai.jp")) return undefined;
      return {
        openai: {
          reasoningEffort: settings.openaiReasoningEffort,
          reasoningSummary: "detailed",
        },
      };
    }
    case "anthropic": {
      if (!settings.anthropicThinkingEnabled || settings.anthropicThinkingBudget == null) return undefined;
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
      if (toolsEnabled) {
        // DeepSeek の thinking モードはツール呼び出しに対応していない。
        return {
          deepseek: { thinking: { type: "disabled" } },
        };
      }
      const options: Record<string, JSONValue> = {
        // DeepSeek V4 系は thinking がデフォルトで有効。温度・top_p・ペナルティ類は
        // thinking モードで無視されるため、通常時はここで有効にしておく。
        thinking: { type: "enabled" },
      };
      if (settings.deepseekReasoningEffort) {
        options.reasoningEffort = settings.deepseekReasoningEffort;
      }
      return { deepseek: options };
    }
    case "sakura":
      return {
        openai: {
          // Sakura AI Engine の Responses API は OpenAI 互換だが、
          // 本家 OpenAI の永続化状態や並列 tool call に依存しない形へ寄せる。
          store: false,
          parallelToolCalls: false,
          strictJsonSchema: false,
          reasoningSummary: "detailed",
        },
      };
    case "google": {
      // thinkingLevel は Gemini 3 系のみ対応。Gemma 系や Gemini 2.x 系に送ると
      // 無視されるか未定義動作になり得るため、モデル名で確実に絞る。
      if (!isGemini3Model(settings.model)) return undefined;
      // includeThoughts: true が無いと、モデルが内部で思考していても reasoning
      // コンテンツがレスポンスに含まれず、アプリの思考表示が機能しない
      // （OpenCode の src/provider/transform.ts options() で全 Gemini reasoning
      // モデル共通のベース設定として無条件に付与されているのを参考にした）。
      // thinkingLevel は未設定なら省略し、API 側の既定（公式ドキュメント上は
      // モデルごとに high 相当）に委ねる。
      return {
        google: {
          thinkingConfig: {
            includeThoughts: true,
            ...(settings.googleThinkingLevel ? { thinkingLevel: settings.googleThinkingLevel } : {}),
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
 * それ以外のプロバイダでは AI SDK のデフォルトリトライ（2回）を維持する。
 */
export function buildRetryOption(settings: AiSettings): { maxRetries?: number } {
  if (settings.provider === "opencode" || settings.provider === "sakura") {
    return { maxRetries: 0 };
  }
  return {};
}

/**
 * AI 呼び出しのエラーメッセージをユーザー向けに整形する。
 * 一時的な上流エラーやレートリミットの場合は再試行を促すヒントを追加する。
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
