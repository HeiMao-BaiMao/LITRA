import { fetch } from "@tauri-apps/plugin-http";
import type { AiSettings } from "../settings.ts";
import {
  getProviderEntry,
  getProviderModelIds,
  isFixedModelSelection,
  loadProviderConfig,
  providerRequiresApiKey,
} from "../providers/config.ts";

export interface ModelListResult {
  models: string[];
  error?: string;
}

/// 設定モーダルの固定モデルドロップダウンで使う表示用エントリ。
/// 実体は providers.json の各プロバイダー `models` から導出する。
export interface FixedModel {
  id: string;
  label: string;
}

// モデル一覧取得のタイムアウト。SDK 既定（OpenAI は 10 分）だと
// サーバー無応答時に「取得」ボタンがハングしたように見えるため短く切る。
const MODEL_FETCH_TIMEOUT_MS = 15000;

// Google の /models はページネーション付き。異常応答でも無限ループしないよう上限を設ける。
const GOOGLE_MODELS_MAX_PAGES = 10;

/// 取得失敗時・取得結果補完用のフォールバック（providers.json に定義済みのモデル一覧）。
function getFallbackModels(configuredModels: string[]): string[] | undefined {
  return configuredModels.length > 0 ? configuredModels : undefined;
}

async function fetchOpenAiCompatibleModels(
  settings: AiSettings,
  configuredModels: string[],
): Promise<ModelListResult> {
  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({
      apiKey: settings.apiKey || "sk-no-key-required",
      baseURL: settings.baseUrl,
      fetch,
      dangerouslyAllowBrowser: true,
      timeout: MODEL_FETCH_TIMEOUT_MS,
    });

    const response = await client.models.list();
    const fetchedModels = response.data
      .map((model) => model.id)
      .filter((id): id is string => typeof id === "string");

    // `/v1/models` が不完全な一覧を返すプロバイダーがあるため、
    // 取得結果と providers.json の定義済みモデルを統合する。
    const fallback = getFallbackModels(configuredModels);
    const models = fallback
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

    const fallback = getFallbackModels(configuredModels);
    if (fallback) {
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
      timeout: MODEL_FETCH_TIMEOUT_MS,
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
  supportedGenerationMethods?: string[];
}

interface GoogleModelsResponse {
  models?: GoogleModelEntry[];
  nextPageToken?: string;
}

async function fetchGoogleModels(
  settings: AiSettings,
  configuredModels: string[],
): Promise<ModelListResult> {
  try {
    const baseUrl = settings.baseUrl || "https://generativelanguage.googleapis.com/v1beta";
    const fetched: string[] = [];
    let pageToken: string | undefined;

    for (let page = 0; page < GOOGLE_MODELS_MAX_PAGES; page++) {
      const url = new URL(`${baseUrl.replace(/\/$/, "")}/models`);
      url.searchParams.set("pageSize", "1000");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          "x-goog-api-key": settings.apiKey,
        },
        signal: AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        const text = await response.text();
        return { models: [], error: `モデル一覧の取得に失敗しました: ${response.status} ${text}` };
      }

      const data = (await response.json()) as GoogleModelsResponse;
      for (const model of data.models ?? []) {
        if (!model.name) continue;
        if (
          model.supportedGenerationMethods &&
          !model.supportedGenerationMethods.includes("generateContent")
        ) {
          continue;
        }
        fetched.push(model.name.replace(/^models\//, ""));
      }

      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }

    const fallback = getFallbackModels(configuredModels);
    const models = fallback
      ? Array.from(new Set([...fetched, ...fallback])).sort()
      : Array.from(new Set(fetched)).sort();

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

  const configuredModels = getProviderModelIds(entry);

  // 固定モデル方式: providers.json の models 一覧をそのまま返す
  // （ネットワークに出ないため API キー未設定でも動作する）。
  if (isFixedModelSelection(entry)) {
    return { models: configuredModels };
  }

  if (providerRequiresApiKey(entry) && !settings.apiKey) {
    return { models: [], error: "API キーが設定されていません。" };
  }

  switch (entry.sdkType) {
    case "openai":
      return fetchOpenAiCompatibleModels(settings, configuredModels);
    case "anthropic":
      return fetchAnthropicModels(settings);
    case "google":
      return fetchGoogleModels(settings, configuredModels);
  }
}
