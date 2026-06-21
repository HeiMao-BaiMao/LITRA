import { createOpenAI } from "@ai-sdk/openai";
import { fetch } from "@tauri-apps/plugin-http";
import type { AiSettings } from "../settings.ts";

export function createProvider(settings: AiSettings) {
  return createOpenAI({
    apiKey: settings.apiKey,
    baseURL: settings.baseUrl,
    fetch,
  });
}
