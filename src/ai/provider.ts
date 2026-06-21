import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { fetch } from "@tauri-apps/plugin-http";
import type { AiSettings } from "../settings.ts";

export function createModel(settings: AiSettings) {
  const baseURL = settings.baseUrl.trim();
  const apiKey =
    settings.apiKey.trim() || (settings.provider === "llamacpp" ? "sk-no-key-required" : settings.apiKey);
  const common = {
    apiKey,
    fetch,
    ...(baseURL ? { baseURL } : {}),
  };

  switch (settings.provider) {
    case "openai":
    case "llamacpp":
    case "sakura":
      return createOpenAI(common)(settings.model);
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
