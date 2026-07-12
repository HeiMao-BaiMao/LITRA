/**
 * 実行時のモデル設定解決(チャット/執筆系/判断系/バックグラウンド)。
 * main.ts に私有されていた解決ロジックを、設定モーダルのプレビューなど
 * 他モジュールからも同じ結果を計算できるよう共有化したもの。
 * モジュール変数には依存せず、ProviderConfig を引数で受け取る。
 */

import {
  resolveChatSettings,
  resolveBackgroundSettings,
  resolveWritingSettings,
  resolveJudgmentSettings,
  type AiSettings,
  type AnthropicThinkingEffort,
  type RoleParamOverrides,
} from "../settings.ts";
import {
  getProviderEntry,
  getProviderModelDefaults,
  type ModelRoleProfile,
  type ProviderConfig,
  type ProviderModelDefaults,
} from "../providers/config.ts";
import { getEffectiveCapability, isDeepSeekV4Model } from "./capability.ts";
import { getCopilotModelCacheEntry } from "../providers/copilot-auth.ts";

export const NON_THINKING_WRITING_MAX_TOKENS = 8192;

export function enforceRequiredThinking(settings: AiSettings): AiSettings {
  return isDeepSeekV4Model(settings.model)
    ? { ...settings, deepseekThinkingEnabled: true }
    : settings;
}

export function isThinkingEnabledForRun(settings: AiSettings): boolean {
  if (isDeepSeekV4Model(settings.model)) return true;
  const capability = settings.reasoningCapability;
  if (capability?.kind === "deepseek" || (!capability && settings.provider === "deepseek")) {
    return settings.deepseekThinkingEnabled !== false;
  }
  if (capability?.kind === "anthropic-adaptive") return true;
  if (capability?.kind === "anthropic-budget" || (!capability && settings.provider === "anthropic")) {
    return settings.anthropicThinkingEnabled === true;
  }
  if (capability?.kind === "openai" || (!capability && (settings.provider === "openai" || settings.provider === "codex"))) {
    return Boolean(settings.openaiReasoningEffort && settings.openaiReasoningEffort !== "none");
  }
  if (capability?.kind === "google") return true;
  // OpenCode GoのV4系は明示的なThinking OFFを現在提供しておらず、既定挙動を維持する。
  if (settings.provider === "opencode") return true;
  return false;
}

export function applyRuntimeModelDefaults(
  settings: AiSettings,
  defaults: ProviderModelDefaults | undefined,
  applyTokenDefaults: boolean,
): AiSettings {
  if (!defaults) return settings;

  const capability = getEffectiveCapability(
    settings.provider,
    settings.model,
    defaults,
    getCopilotModelCacheEntry,
  );
  const next: AiSettings = {
    ...settings,
    temperature: defaults.temperature ?? settings.temperature,
    maxTokens: applyTokenDefaults ? defaults.maxTokens ?? settings.maxTokens : settings.maxTokens,
    maxContextTokens: applyTokenDefaults ? defaults.maxContextTokens ?? settings.maxContextTokens : settings.maxContextTokens,
    topP: defaults.topP,
    topK: defaults.topK,
    frequencyPenalty: defaults.frequencyPenalty,
    presencePenalty: defaults.presencePenalty,
    reasoningCapability: capability,
  };
  if (capability?.kind === "openai") {
    next.openaiReasoningEffort = defaults.openaiReasoningEffort ?? settings.openaiReasoningEffort;
  } else if (capability?.kind === "deepseek") {
    next.deepseekReasoningEffort = defaults.deepseekReasoningEffort ?? settings.deepseekReasoningEffort;
  } else if (capability?.kind === "anthropic-adaptive") {
    next.anthropicThinkingEnabled = true;
    next.anthropicThinkingBudget = undefined;
    const defaultEffort = capability.defaultEffort;
    const validDefaultEffort =
      defaultEffort === "low" || defaultEffort === "medium" || defaultEffort === "high" ||
      defaultEffort === "xhigh" || defaultEffort === "max"
        ? defaultEffort as AnthropicThinkingEffort
        : undefined;
    next.anthropicThinkingEffort = defaults.anthropicThinkingEffort ?? settings.anthropicThinkingEffort ?? validDefaultEffort;
  } else if (capability?.kind === "anthropic-budget") {
    next.anthropicThinkingEnabled = defaults.anthropicThinkingEnabled ?? settings.anthropicThinkingEnabled;
    next.anthropicThinkingBudget = defaults.anthropicThinkingBudget ?? settings.anthropicThinkingBudget;
    next.anthropicThinkingEffort = undefined;
  } else if (capability?.kind === "google") {
    next.googleThinkingLevel = defaults.googleThinkingLevel ?? settings.googleThinkingLevel;
  }
  return next;
}

/**
 * 役割プロファイル(providers.json の writing/judgment)またはユーザーの役割別
 * オーバーライドを1レイヤー分だけ設定へ重ねる内部ヘルパー。
 * サンプリング系パラメータと promptScaffold は無条件で上書きする。
 * reasoning/thinking 系は applyRuntimeModelDefaults と同じ方式で、現在のプロバイダに
 * 一致するフィールドだけを適用する(不一致のフィールドは無視するだけで、
 * 対象プロバイダのフィールドを undefined 化はしない)。
 */
function applyRoleProfileLayer(settings: AiSettings, layer: ModelRoleProfile | undefined): AiSettings {
  if (!layer) return settings;
  const next: AiSettings = { ...settings };

  if (layer.temperature !== undefined) next.temperature = layer.temperature;
  if (layer.topP !== undefined) next.topP = layer.topP;
  if (layer.topK !== undefined) next.topK = layer.topK;
  if (layer.frequencyPenalty !== undefined) next.frequencyPenalty = layer.frequencyPenalty;
  if (layer.presencePenalty !== undefined) next.presencePenalty = layer.presencePenalty;
  if (layer.promptScaffold !== undefined) next.promptScaffold = layer.promptScaffold;

  const kind = settings.reasoningCapability?.kind;
  if (kind === "openai" && layer.openaiReasoningEffort !== undefined) {
    next.openaiReasoningEffort = layer.openaiReasoningEffort;
  }
  if (kind === "deepseek") {
    if (layer.deepseekReasoningEffort !== undefined) next.deepseekReasoningEffort = layer.deepseekReasoningEffort;
    if (layer.deepseekThinkingEnabled !== undefined) next.deepseekThinkingEnabled = layer.deepseekThinkingEnabled;
  }
  if (kind === "anthropic-adaptive") {
    if (layer.anthropicThinkingEffort !== undefined) next.anthropicThinkingEffort = layer.anthropicThinkingEffort;
    next.anthropicThinkingEnabled = true;
    next.anthropicThinkingBudget = undefined;
  }
  if (kind === "anthropic-budget") {
    if (layer.anthropicThinkingEnabled !== undefined) next.anthropicThinkingEnabled = layer.anthropicThinkingEnabled;
    if (layer.anthropicThinkingBudget !== undefined) next.anthropicThinkingBudget = layer.anthropicThinkingBudget;
  }
  if (kind === "google" && layer.googleThinkingLevel !== undefined) {
    next.googleThinkingLevel = layer.googleThinkingLevel;
  }

  return next;
}

/// providers.json の役割プロファイルを先に、ユーザーの役割別オーバーライドを後に重ねる(後勝ち)。
export function applyRoleProfile(
  settings: AiSettings,
  profile: ModelRoleProfile | undefined,
  overrides: RoleParamOverrides | undefined,
): AiSettings {
  return applyRoleProfileLayer(applyRoleProfileLayer(settings, profile), overrides);
}

export function resolveChatRunSettings(config: ProviderConfig, settings: AiSettings): AiSettings {
  const resolved = resolveChatSettings(settings);
  const entry = getProviderEntry(config, resolved.provider);
  const usesChatOverride = resolved.provider !== settings.provider || resolved.model !== settings.model;
  return enforceRequiredThinking(
    applyRuntimeModelDefaults(resolved, getProviderModelDefaults(entry, resolved.model), usesChatOverride),
  );
}

export function resolveBackgroundRunSettings(config: ProviderConfig, settings: AiSettings): AiSettings {
  const resolved = resolveBackgroundSettings(settings);
  const entry = getProviderEntry(config, resolved.provider);
  const usesBackgroundOverride =
    resolved.provider !== settings.provider || resolved.model !== settings.model;
  return enforceRequiredThinking(applyRuntimeModelDefaults(
    resolved,
    getProviderModelDefaults(entry, resolved.model),
    usesBackgroundOverride,
  ));
}

export function resolveWritingRunSettings(config: ProviderConfig, settings: AiSettings): AiSettings {
  // 執筆系の選択元を解決してから、モデル既定値と役割上書きを適用する。
  // モデル既定値 → 役割プロファイル → ユーザーの役割別オーバーライド の順で重ねる
  // (トークン上限だけは保存済みのグローバル値を維持する)。
  const resolved = resolveWritingSettings(settings);
  const defaults = getProviderModelDefaults(getProviderEntry(config, resolved.provider), resolved.model);
  const usesOverride = resolved.provider !== settings.provider || resolved.model !== settings.model;
  const base = applyRuntimeModelDefaults(resolved, defaults, usesOverride);
  const withWritingProfile = enforceRequiredThinking(
    applyRoleProfile(base, defaults?.writing, settings.writingOverrides),
  );
  return isThinkingEnabledForRun(withWritingProfile)
    ? withWritingProfile
    : {
        ...withWritingProfile,
        maxTokens: Math.min(withWritingProfile.maxTokens, NON_THINKING_WRITING_MAX_TOKENS),
      };
}

export function resolveJudgmentRunSettings(config: ProviderConfig, settings: AiSettings): AiSettings {
  const resolved = resolveJudgmentSettings(settings);
  const entry = getProviderEntry(config, resolved.provider);
  const defaults = getProviderModelDefaults(entry, resolved.model);
  const usesOverride = resolved.provider !== settings.provider || resolved.model !== settings.model;
  const base = applyRuntimeModelDefaults(resolved, defaults, usesOverride);
  return enforceRequiredThinking(
    applyRoleProfile(base, defaults?.judgment, settings.judgmentOverrides),
  );
}
