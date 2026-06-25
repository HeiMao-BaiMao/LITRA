import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { fetch } from "@tauri-apps/plugin-http";
import type { AiSettings } from "../settings.ts";

function isOfficialOpenAIBaseUrl(baseURL: string): boolean {
  return !baseURL || baseURL === "https://api.openai.com/v1";
}

function isOpenAIResponsesModel(model: string): boolean {
  // @ai-sdk/openai v3.0.73 ではデフォルトのモデル関数が Responses API を使う。
  // Chat Completions を使いたい場合は .chat() を呼ぶ必要がある。
  // Responses API を使うべきなのは OpenAI 公式の推論モデルのみ。
  const m = model.trim().toLowerCase();
  return (
    m.startsWith("o1") ||
    m.startsWith("o3") ||
    m.startsWith("o4-mini") ||
    (m.startsWith("gpt-5") && !m.startsWith("gpt-5-chat"))
  );
}

export function createModel(settings: AiSettings) {
  const baseURL = settings.baseUrl.trim();
  const apiKey =
    settings.apiKey.trim() || (settings.provider === "llamacpp" ? "sk-no-key-required" : settings.apiKey);
  const useResponsesAPI =
    settings.provider === "openai" &&
    isOfficialOpenAIBaseUrl(baseURL) &&
    isOpenAIResponsesModel(settings.model);
  console.log(
    "[phenex] createModel",
    JSON.stringify({
      provider: settings.provider,
      model: settings.model,
      baseURL: baseURL || "(default)",
      hasApiKey: Boolean(apiKey && apiKey !== "sk-no-key-required"),
      useResponsesAPI,
    }),
  );
  const common = {
    apiKey,
    fetch,
    ...(baseURL ? { baseURL } : {}),
  };

  switch (settings.provider) {
    case "openai":
    case "llamacpp":
    case "sakura":
    case "plamo": {
      const openai = createOpenAI(common);
      return useResponsesAPI ? openai(settings.model) : openai.chat(settings.model);
    }
    case "anthropic":
      return createAnthropic(common)(settings.model);
    case "deepseek":
      return createDeepSeek(common)(settings.model);
    case "google":
      return createGoogleGenerativeAI(common)(settings.model);
    default: {
      const provider: never = settings.provider;
      throw new Error(`Unsupported AI provider: ${provider}`);
    }
  }
}
