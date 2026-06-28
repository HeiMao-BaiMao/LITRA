import {
  BaseDirectory,
  exists,
  mkdir,
  readTextFile,
  remove,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

export type SdkType = "openai" | "anthropic" | "google";

export interface ProviderModelDefaults {
  id: string;
  label?: string;
  temperature?: number;
  maxTokens?: number;
  maxContextTokens?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  openaiReasoningEffort?: "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
  deepseekReasoningEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  anthropicThinkingEnabled?: boolean;
  anthropicThinkingBudget?: number;
}

export interface ProviderEntry {
  id: string;
  name: string;
  sdkType: SdkType;
  defaultBaseUrl: string;
  defaultModel: string;
  requiresApiKey?: boolean;
  models?: ProviderModelDefaults[];
}

export interface ProviderConfig {
  providers: ProviderEntry[];
}

const CONFIG_FILE = "providers.json";
const BASE_DIR = BaseDirectory.AppConfig;

import defaultProviders from "./default-providers.json" with { type: "json" };

const DEFAULT_CONFIG: ProviderConfig = defaultProviders as ProviderConfig;

async function initializeDefaultConfig(): Promise<void> {
  await mkdir("", { baseDir: BASE_DIR, recursive: true });
  const text = JSON.stringify(DEFAULT_CONFIG, null, 2);
  await writeTextFile(CONFIG_FILE, text, { baseDir: BASE_DIR });
}

function mergeDefaultModels(
  existingModels: ProviderModelDefaults[] | undefined,
  defaultModels: ProviderModelDefaults[] | undefined,
): ProviderModelDefaults[] | undefined {
  if (!existingModels && !defaultModels) return undefined;

  const mergedById = new Map<string, ProviderModelDefaults>();
  for (const model of defaultModels ?? []) {
    mergedById.set(model.id, model);
  }
  for (const model of existingModels ?? []) {
    mergedById.set(model.id, {
      ...(mergedById.get(model.id) ?? {}),
      ...model,
    });
  }

  return Array.from(mergedById.values());
}

function mergeDefaultProviders(config: ProviderConfig): ProviderConfig {
  const existingById = new Map(config.providers.map((p) => [p.id, p]));
  const merged: ProviderEntry[] = [];

  for (const defaultProvider of DEFAULT_CONFIG.providers) {
    const existing = existingById.get(defaultProvider.id);
    if (existing) {
      merged.push({
        ...defaultProvider,
        ...existing,
        defaultBaseUrl: existing.defaultBaseUrl || defaultProvider.defaultBaseUrl,
        defaultModel: defaultProvider.defaultModel,
        requiresApiKey: existing.requiresApiKey ?? defaultProvider.requiresApiKey,
        models:
          defaultProvider.id === "sakura" || defaultProvider.id === "opencode"
            ? defaultProvider.models
            : mergeDefaultModels(existing.models, defaultProvider.models),
      });
      existingById.delete(defaultProvider.id);
    } else {
      merged.push(defaultProvider);
    }
  }

  merged.push(...existingById.values());

  return { providers: merged };
}

export async function resetProviderConfig(): Promise<void> {
  const fileExists = await exists(CONFIG_FILE, { baseDir: BASE_DIR });
  if (fileExists) {
    await remove(CONFIG_FILE, { baseDir: BASE_DIR });
  }
}

export async function loadProviderConfig(): Promise<ProviderConfig> {
  const fileExists = await exists(CONFIG_FILE, { baseDir: BASE_DIR });
  if (!fileExists) {
    await initializeDefaultConfig();
  }

  const text = await readTextFile(CONFIG_FILE, { baseDir: BASE_DIR });
  const parsed: unknown = JSON.parse(text);

  if (!isProviderConfig(parsed)) {
    throw new Error("providers.json の形式が不正です。");
  }

  const merged = mergeDefaultProviders(parsed);
  if (JSON.stringify(merged) !== JSON.stringify(parsed)) {
    await writeTextFile(CONFIG_FILE, JSON.stringify(merged, null, 2), { baseDir: BASE_DIR });
  }

  return merged;
}

export function getProviderEntry(
  config: ProviderConfig,
  providerId: string,
): ProviderEntry | undefined {
  return config.providers.find((provider) => provider.id === providerId);
}

export function getProviderModelDefaults(
  provider: ProviderEntry | undefined,
  modelId: string,
): ProviderModelDefaults | undefined {
  return provider?.models?.find((model) => model.id === modelId);
}

export function getProviderModelIds(provider: ProviderEntry | undefined): string[] {
  return provider?.models?.map((model) => model.id) ?? [];
}

export function providerRequiresApiKey(provider: ProviderEntry | undefined): boolean {
  return provider?.requiresApiKey ?? true;
}

function isProviderModelDefaults(value: unknown): value is ProviderModelDefaults {
  if (typeof value !== "object" || value === null) return false;
  const model = value as Partial<ProviderModelDefaults>;
  return (
    typeof model.id === "string" &&
    (model.label === undefined || typeof model.label === "string") &&
    (model.temperature === undefined || typeof model.temperature === "number") &&
    (model.maxTokens === undefined || typeof model.maxTokens === "number") &&
    (model.maxContextTokens === undefined || typeof model.maxContextTokens === "number") &&
    (model.topP === undefined || typeof model.topP === "number") &&
    (model.topK === undefined || typeof model.topK === "number") &&
    (model.frequencyPenalty === undefined || typeof model.frequencyPenalty === "number") &&
    (model.presencePenalty === undefined || typeof model.presencePenalty === "number") &&
    (model.openaiReasoningEffort === undefined ||
      model.openaiReasoningEffort === "none" ||
      model.openaiReasoningEffort === "minimal" ||
      model.openaiReasoningEffort === "low" ||
      model.openaiReasoningEffort === "medium" ||
      model.openaiReasoningEffort === "high" ||
      model.openaiReasoningEffort === "xhigh") &&
    (model.deepseekReasoningEffort === undefined ||
      model.deepseekReasoningEffort === "low" ||
      model.deepseekReasoningEffort === "medium" ||
      model.deepseekReasoningEffort === "high" ||
      model.deepseekReasoningEffort === "xhigh" ||
      model.deepseekReasoningEffort === "max") &&
    (model.anthropicThinkingEnabled === undefined || typeof model.anthropicThinkingEnabled === "boolean") &&
    (model.anthropicThinkingBudget === undefined || typeof model.anthropicThinkingBudget === "number")
  );
}

function isProviderConfig(value: unknown): value is ProviderConfig {
  if (typeof value !== "object" || value === null) return false;
  const config = value as Partial<ProviderConfig>;
  if (!Array.isArray(config.providers)) return false;

  return config.providers.every((provider) => {
    const p = provider as Partial<ProviderEntry>;
    return (
      typeof p.id === "string" &&
      typeof p.name === "string" &&
      (p.sdkType === "openai" || p.sdkType === "anthropic" || p.sdkType === "google") &&
      typeof p.defaultBaseUrl === "string" &&
      typeof p.defaultModel === "string" &&
      (p.requiresApiKey === undefined || typeof p.requiresApiKey === "boolean") &&
      (p.models === undefined || (Array.isArray(p.models) && p.models.every(isProviderModelDefaults)))
    );
  });
}
