/**
 * 実行時のモデル設定解決(チャット/執筆系/判断系/バックグラウンド)。
 * main.ts に私有されていた解決ロジックを、設定モーダルのプレビューなど
 * 他モジュールからも同じ結果を計算できるよう共有化したもの。
 * モジュール変数には依存せず、ProviderConfig を引数で受け取る。
 */

import {
  resolveChatSettings,
  resolveBackgroundSettings,
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
import { getEffectiveCapability } from "./capability.ts";
import { getCopilotModelCacheEntry } from "../providers/copilot-auth.ts";

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
  return applyRuntimeModelDefaults(resolved, getProviderModelDefaults(entry, resolved.model), usesChatOverride);
}

export function resolveBackgroundRunSettings(config: ProviderConfig, settings: AiSettings): AiSettings {
  const resolved = resolveBackgroundSettings(settings);
  const entry = getProviderEntry(config, resolved.provider);
  const usesBackgroundOverride =
    resolved.provider !== settings.provider || resolved.model !== settings.model;
  return applyRuntimeModelDefaults(
    resolved,
    getProviderModelDefaults(entry, resolved.model),
    usesBackgroundOverride,
  );
}

export function resolveWritingRunSettings(config: ProviderConfig, settings: AiSettings): AiSettings {
  // 本文モデルをそのまま執筆系として使う。判断系と同じく
  // モデル既定値 → 役割プロファイル → ユーザーの役割別オーバーライド の順で重ねる
  // (トークン上限だけは保存済みのグローバル値を維持する)。
  const defaults = getProviderModelDefaults(getProviderEntry(config, settings.provider), settings.model);
  const base = applyRuntimeModelDefaults(settings, defaults, false);
  return applyRoleProfile(base, defaults?.writing, settings.writingOverrides);
}

export function resolveJudgmentRunSettings(config: ProviderConfig, settings: AiSettings): AiSettings {
  const resolved = resolveJudgmentSettings(settings);
  const entry = getProviderEntry(config, resolved.provider);
  const defaults = getProviderModelDefaults(entry, resolved.model);
  const usesOverride = resolved.provider !== settings.provider || resolved.model !== settings.model;
  const base = applyRuntimeModelDefaults(resolved, defaults, usesOverride);
  return applyRoleProfile(base, defaults?.judgment, settings.judgmentOverrides);
}
