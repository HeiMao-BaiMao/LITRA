import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { AiSettings } from "../settings.ts";

async function debugFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const body = init?.body ? String(init.body) : undefined;
  console.log("[phenex] fetch request", url, body);
  const res = await tauriFetch(input, init);
  const clone = res.clone ? res.clone() : res;
  const text = await clone.text();
  console.log("[phenex] fetch response", res.status, text.slice(0, 500));
  return res;
}

export function createModel(settings: AiSettings) {
  const baseURL = settings.baseUrl.trim();
  const apiKey =
    settings.apiKey.trim() || (settings.provider === "llamacpp" ? "sk-no-key-required" : settings.apiKey);
  console.log(
    "[phenex] createModel",
    JSON.stringify({
      provider: settings.provider,
      model: settings.model,
      baseURL: baseURL || "(default)",
      hasApiKey: Boolean(apiKey && apiKey !== "sk-no-key-required"),
    }),
  );
  const common = {
    apiKey,
    fetch: debugFetch,
    ...(baseURL ? { baseURL } : {}),
  };

  switch (settings.provider) {
    case "openai":
    case "llamacpp":
    case "sakura":
    case "plamo": {
      const openai = createOpenAI(common);
      // PLaMo は /v1/responses に対応していないので chat completions を使う。
      // 他の OpenAI 互換サービスは responses API に対応している可能性があるため、
      // PLaMo だけを特別扱いする。
      if (settings.provider === "plamo") {
        return openai.chat(settings.model);
      }
      return openai(settings.model);
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
