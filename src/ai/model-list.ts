import { fetch } from "@tauri-apps/plugin-http";
import type { AiSettings } from "../settings.ts";
import {
  getProviderEntry,
  getProviderModelIds,
  loadProviderConfig,
  providerRequiresApiKey,
} from "../providers/config.ts";

export interface ModelListResult {
  models: string[];
  error?: string;
}

/**
 * DeepSeek API は OpenAI 互換の `/v1/models` エンドポイントを提供していない。
 * 取得に失敗した場合は、公式ドキュメントで公開されている既知のモデル一覧を
 * フォールバックとして返す。
 */
export interface DeepSeekFixedModel {
  id: string;
  label: string;
}

/**
 * DeepSeek の固定モデル選択肢。
 * ストリーミングで content を返すには thinking を無効にする必要がある。
 */
export const DEEPSEEK_FIXED_MODELS: DeepSeekFixedModel[] = [
  { id: "deepseek-v4-flash", label: "DeepSeek-V4 Flash" },
  { id: "deepseek-v4-pro", label: "DeepSeek-V4 Pro" },
];

function getOpenAiFallbackModels(
  providerId: string,
  baseUrl: string,
  configuredModels: string[],
): string[] | undefined {
  const isDeepSeek =
    providerId === "deepseek" || baseUrl.includes("api.deepseek.com");
  if (isDeepSeek) {
    return Array.from(new Set([...configuredModels, ...DEEPSEEK_FIXED_MODELS.map((m) => m.id)]));
  }
  if (configuredModels.length > 0) {
    return configuredModels;
  }
  return undefined;
}

async function fetchOpenAiCompatibleModels(
  settings: AiSettings,
  providerId: string,
  configuredModels: string[],
): Promise<ModelListResult> {
  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({
      apiKey: settings.apiKey || "sk-no-key-required",
      baseURL: settings.baseUrl,
      fetch,
      dangerouslyAllowBrowser: true,
    });

    const response = await client.models.list();
    const fetchedModels = response.data
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string");

    // DeepSeek の /v1/models は返すモデルが不完全なことがあるため、
    // 取得結果と既知のフォールバック一覧を統合する。
    const fallback = getOpenAiFallbackModels(providerId, settings.baseUrl, configuredModels);
    const models =
      fallback && fallback.length > 0
        ? Array.from(new Set([...fetchedModels, ...fallback])).sort()
        : [...fetchedModels].sort();

    return { models };
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error
        ? (error as { status?: number }).status
        : undefined;

    // 認証エラー時はフォールバックせず、そのままエラーを返す。
    if (status === 401 || status === 403) {
      const message = error instanceof Error ? error.message : String(error);
      return { models: [], error: message };
    }

    const fallback = getOpenAiFallbackModels(providerId, settings.baseUrl, configuredModels);
    if (fallback && fallback.length > 0) {
      return { models: fallback };
    }

    const message = error instanceof Error ? error.message : String(error);
    return { models: [], error: message };
  }
}

async function fetchAnthropicModels(
  settings: AiSettings,
): Promise<ModelListResult> {
  try {
    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic({
      apiKey: settings.apiKey,
      baseURL: settings.baseUrl,
      fetch,
      dangerouslyAllowBrowser: true,
    });

    const response = await client.models.list();
    const models = response.data
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string")
      .sort();

    return { models };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { models: [], error: message };
  }
}

interface GoogleModelEntry {
  name?: string;
  displayName?: string;
  supportedGenerationMethods?: string[];
}

interface GoogleModelsResponse {
  models?: GoogleModelEntry[];
}

async function fetchGoogleModels(
  settings: AiSettings,
): Promise<ModelListResult> {
  try {
    const baseUrl = settings.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
    const response = await fetch(`${baseUrl}/models`, {
      method: "GET",
      headers: {
        "x-goog-api-key": settings.apiKey,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      return { models: [], error: `モデル一覧の取得に失敗しました: ${response.status} ${text}` };
    }

    const data = (await response.json()) as GoogleModelsResponse;
    const models = (data.models ?? [])
      .filter(
        (model) =>
          model.name &&
          (!model.supportedGenerationMethods ||
            model.supportedGenerationMethods.includes("generateContent")),
      )
      .map((model) => model.name!.replace(/^models\//, ""))
      .filter((id): id is string => typeof id === "string")
      .sort();

    return { models };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { models: [], error: message };
  }
}

export async function fetchAvailableModels(
  settings: AiSettings,
): Promise<ModelListResult> {
  const config = await loadProviderConfig();
  const entry = getProviderEntry(config, settings.provider);

  if (!entry) {
    return { models: [], error: "未知のプロバイダーです。" };
  }

  if (providerRequiresApiKey(entry) && !settings.apiKey) {
    return { models: [], error: "API キーが設定されていません。" };
  }

  const configuredModels = getProviderModelIds(entry);

  switch (entry.sdkType) {
    case "openai":
      return fetchOpenAiCompatibleModels(settings, entry.id, configuredModels);
    case "anthropic":
      return fetchAnthropicModels(settings);
    case "google":
      return fetchGoogleModels(settings);
  }
}
