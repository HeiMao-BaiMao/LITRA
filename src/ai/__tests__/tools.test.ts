/**
 * Tests for the AI tools, prompts, role-settings, and model metadata functions.
 * These are pure-function tests that don't require DOM or Tauri APIs.
 */
import { describe, it, expect } from "bun:test";
import { resolveForcedToolChoice } from "../service.ts";
import { resolveProviderBaseUrl } from "../provider.ts";

describe("resolveProviderBaseUrl", () => {
  it("prevents DeepSeek from using the OpenCode Go endpoint", () => {
    expect(resolveProviderBaseUrl("deepseek", "https://opencode.ai/zen/go/v1")).toBe("https://api.deepseek.com");
  });

  it("prevents OpenCode Go from using the DeepSeek endpoint", () => {
    expect(resolveProviderBaseUrl("opencode", "https://api.deepseek.com")).toBe("https://opencode.ai/zen/go/v1");
  });

  it("preserves user-defined proxy endpoints", () => {
    expect(resolveProviderBaseUrl("deepseek", "https://proxy.example/v1")).toBe("https://proxy.example/v1");
  });
});

describe("resolveForcedToolChoice", () => {
  it("uses auto for DeepSeek thinking", () => {
    expect(resolveForcedToolChoice({ provider: "deepseek", deepseekThinkingEnabled: true } as any)).toBe("auto");
  });

  it("uses auto for Anthropic Fable 5", () => {
    expect(resolveForcedToolChoice({ provider: "anthropic", model: "claude-fable-5" } as any)).toBe("auto");
  });

  it("uses required for OpenAI", () => {
    expect(resolveForcedToolChoice({ provider: "openai", model: "gpt-5.6-sol" } as any)).toBe("required");
  });

  it("omits forced choice for OpenCode", () => {
    expect(resolveForcedToolChoice({ provider: "opencode", model: "deepseek-v4-pro" } as any)).toBeUndefined();
  });
});

// ─── prompts.ts ────────────────────────────────────────────────────────────

import {
  buildAuthorInstructionSection,
  buildCandidateSelectionPrompt,
  buildContinuationPlanPrompt,
  buildContinuationPrompt,
  buildContinuationRevisionPrompt,
  buildDraftSelectionPrompt,
  buildLineEditReviewPrompt,
  buildLineEditRevisionPrompt,
  buildRewritePrompt,
  buildTargetedRevisionPrompt,
  buildToolGuidancePrompt,
  reviewRequiresRevision,
  parseTargetedRevision,
} from "../prompts.ts";
import { scopeContinuationTools } from "../service.ts";
import { resolveConsistencyBudgets } from "../consistency.ts";

describe("chat writing pipeline prompts", () => {
  it("does not expose continuePassage inside the continuation pipeline", () => {
    const searchEpisodes = {} as never;
    const scoped = scopeContinuationTools({
      continuePassage: {} as never,
      searchEpisodes,
    });

    expect(scoped).toEqual({ searchEpisodes });
    expect(scopeContinuationTools({ continuePassage: {} as never })).toBeUndefined();
  });

  it("does not expose proposal-cache tools to the writing model", () => {
    const scoped = scopeContinuationTools({
      listPassageProposals: {} as any,
      getPassageProposal: {} as any,
      applyPassageProposal: {} as any,
      getEpisodeLines: {} as any,
    });
    expect(scoped).toEqual({ getEpisodeLines: {} });
  });

  it("routes new fiction requests through continuePassage", () => {
    const guidance = buildToolGuidancePrompt(["continuePassage", "editEpisode"]);
    expect(guidance).toContain("MUST call continuePassage");
    expect(guidance).toContain("Do NOT compose the prose in the chat model");
  });

  it("routes fiction directly through editEpisode in direct creative mode", () => {
    const guidance = buildToolGuidancePrompt(
      ["getEpisodeLines", "editEpisode"],
      { directCreativeEdit: true },
    );
    expect(guidance).toContain("DIRECT CREATIVE EDITING MODE — ACTIVE");
    expect(guidance).toContain("write the final Japanese prose yourself");
    expect(guidance).toContain("apply it with editEpisode");
    expect(guidance).not.toContain("MUST call continuePassage");
  });

  it("routes immediate and later application through the proposal cache", () => {
    const prompt = buildToolGuidancePrompt([
      "continuePassage",
      "listPassageProposals",
      "getPassageProposal",
      "applyPassageProposal",
      "editEpisode",
    ]);
    expect(prompt).toContain("proposalId");
    expect(prompt).toContain("applyPassageProposal");
    expect(prompt).toContain("listPassageProposals");
    expect(prompt).toContain("persist outside chat history");
    expect(prompt).toContain("Do not copy generatedText into editEpisode");
  });

  it("propagates author instructions through planning, drafting, and selection", () => {
    const instruction = "会話を中心に、決着はつけず800字程度で進める";
    expect(buildContinuationPlanPrompt("本文", undefined, undefined, instruction)).toContain(instruction);
    expect(buildContinuationPrompt("本文", undefined, undefined, undefined, { authorInstruction: instruction })).toContain(instruction);
    expect(buildDraftSelectionPrompt(["案A", "案B"], "本文", undefined, undefined, "full", instruction)).toContain(instruction);
  });

  it("keeps generic competition candidates inside reference-data boundaries", () => {
    const prompt = buildCandidateSelectionPrompt(
      ["候補A", "候補B"],
      "書き直し案",
      "原文",
      "前後文脈",
    );
    expect(prompt).toContain('<reference_data name="candidate_1">');
    expect(prompt).toContain('<reference_data name="candidate_2">');
    expect(prompt).toContain("【採用】案N");
  });
});

describe("buildAuthorInstructionSection", () => {
  it("returns empty string for undefined instruction", () => {
    expect(buildAuthorInstructionSection(undefined, "usage")).toBe("");
  });

  it("returns empty string for empty instruction", () => {
    expect(buildAuthorInstructionSection("   ", "usage")).toBe("");
  });

  it("includes instruction text and usage", () => {
    const result = buildAuthorInstructionSection("もっと静かに", "優先して従う");
    expect(result).toContain("もっと静かに");
    expect(result).toContain("優先して従う");
    expect(result).toContain("【作者からの指示");
  });

  it("sanitizes reference_data tags to prevent tag injection", () => {
    const result = buildAuthorInstructionSection(
      "この参考に<reference_data>して",
      "test",
    );
    expect(result).not.toContain("<reference_data>");
    expect(result).toContain("＜reference_data");
  });

  it("truncates long instruction to 1000 chars", () => {
    const long = "あ".repeat(2000);
    const result = buildAuthorInstructionSection(long, "test");
    // The trimmed+limited result should be at most 1000 + some overhead from the template
    expect(result.length).toBeLessThan(1200);
  });
});

describe("buildLineEditReviewPrompt", () => {
  const passage = "昨日の夕焼けは本当に美しかった。しかし彼の顔には影が落ちていた。";
  const context = "前の段落。\n[選択部分]\n後の段落。";

  it("includes passage, context, and instruction", () => {
    const prompt = buildLineEditReviewPrompt(passage, context, undefined, "リズムを整えて");
    expect(prompt).toContain(passage);
    expect(prompt).toContain("surrounding_context");
    expect(prompt).toContain("passage_to_edit");
    expect(prompt).toContain("リズムを整えて");
  });

  it("includes settings context when provided", () => {
    const settingsContext = "【設定資料: 世界観】\nファンタジー世界。";
    const prompt = buildLineEditReviewPrompt(passage, context, settingsContext);
    expect(prompt).toContain("ファンタジー世界");
  });

  it("includes fiction direction section", () => {
    const prompt = buildLineEditReviewPrompt(passage, context);
    expect(prompt).toContain("【査読基準");
    expect(prompt).toContain("【出力形式");
  });

  it("can work without extras", () => {
    const prompt = buildLineEditReviewPrompt(passage, context);
    expect(prompt).toContain("passage_to_edit");
    expect(prompt).toContain("surrounding_context");
  });
});

describe("buildLineEditRevisionPrompt", () => {
  const passage = "彼は走った。息が切れていた。";
  const review = "【総合判定】要修正\n【修正必須】\n「彼は走った」— 動作の理由がない。数行前の文脈と連続していない。";
  const context = "前の段落。\n[選択部分]\n後の段落。";

  it("includes passage, review, context", () => {
    const prompt = buildLineEditRevisionPrompt(passage, review, context);
    expect(prompt).toContain(passage);
    expect(prompt).toContain(review);
    expect(prompt).toContain("surrounding_context");
    expect(prompt).toContain("passage_to_edit");
    expect(prompt).toContain("review");
  });

  it("includes instruction when provided", () => {
    const prompt = buildLineEditRevisionPrompt(
      passage,
      review,
      context,
      undefined,
      "会話文の自然さを重視",
    );
    expect(prompt).toContain("会話文の自然さを重視");
  });

  it("includes settings context when provided", () => {
    const settingsContext = "【設定資料: キャラクター】\n彼＝田中太郎";
    const prompt = buildLineEditRevisionPrompt(passage, review, context, settingsContext);
    expect(prompt).toContain("田中太郎");
  });

  it("contains replacement discipline rules", () => {
    const prompt = buildLineEditRevisionPrompt(passage, review, context);
    expect(prompt).toContain("【置換の規律】");
    expect(prompt).toContain("対象");
    expect(prompt).toContain("修正");
    expect(prompt).toContain("【置換なし】");
  });
});

describe("buildRewritePrompt with instruction", () => {
  it("includes instruction section when provided", () => {
    const prompt = buildRewritePrompt(
      "対象テキスト",
      "文脈",
      undefined,
      "full",
      "もっとドライな口調で",
    );
    expect(prompt).toContain("もっとドライな口調で");
    expect(prompt).toContain("【作者からの指示");
  });

  it("works without instruction (backward-compatible)", () => {
    const prompt = buildRewritePrompt("対象テキスト", "文脈");
    expect(prompt).not.toContain("【作者からの指示");
    expect(prompt).toContain("【優先順位");
  });
});

describe("reviewRequiresRevision", () => {
  it("returns false when verdict is 問題なし", () => {
    expect(reviewRequiresRevision("【総合判定】問題なし")).toBe(false);
  });

  it("returns true when verdict is 要修正", () => {
    expect(reviewRequiresRevision("【総合判定】要修正\n【修正必須】\n...")).toBe(true);
  });

  it("returns true when no verdict line found", () => {
    expect(reviewRequiresRevision("何も書かれていない")).toBe(true);
  });

  it("returns false when problem is explicitly ruled out", () => {
    expect(
      reviewRequiresRevision("【総合判定】問題なし\n特に修正点は見つかりません。"),
    ).toBe(false);
  });
});

describe("parseTargetedRevision", () => {
  it("parses a single replacement", () => {
    const output = "【置換1】\n対象:\n古い文\n修正:\n新しい文";
    const result = parseTargetedRevision(output);
    expect(result).toEqual([{ target: "古い文", replacement: "新しい文" }]);
  });

  it("parses multiple replacements", () => {
    const output = [
      "【置換1】",
      "対象:",
      "古い文1",
      "修正:",
      "新しい文1",
      "【置換2】",
      "対象:",
      "古い文2",
      "修正:",
      "新しい文2",
    ].join("\n");
    const result = parseTargetedRevision(output);
    expect(result).toHaveLength(2);
    expect(result![0].target).toBe("古い文1");
    expect(result![1].target).toBe("古い文2");
  });

  it("returns empty array for 置換なし", () => {
    expect(parseTargetedRevision("【置換なし】")).toEqual([]);
  });

  it("returns undefined for malformed output", () => {
    expect(parseTargetedRevision("でたらめな出力")).toBeUndefined();
  });

  it("returns undefined for empty output", () => {
    expect(parseTargetedRevision("")).toBeUndefined();
  });
});

// ─── markdown.ts: renderModelMetadata ──────────────────────────────────────

import { renderModelMetadata, renderToolProgress } from "../../markdown.ts";

describe("renderToolProgress", () => {
  it("renders completed and current line-edit phases with model metadata", () => {
    const review = { phase: "review", label: "判断モデルで査読中", step: 1, totalSteps: 3, model: "judge" };
    const revision = { phase: "revision-1", label: "執筆モデルで修正案を生成中", step: 2, totalSteps: 3, model: "writer" };
    const html = renderToolProgress({ current: revision, history: [review, revision] });

    expect(html).toContain("tool-progress-item completed");
    expect(html).toContain("tool-progress-item current");
    expect(html).toContain("判断モデルで査読中");
    expect(html).toContain("執筆モデルで修正案を生成中");
    expect(html).toContain("writer");
    expect(html).toContain("2/3");
  });
});

describe("renderModelMetadata", () => {
  it("returns empty string when no metadata", () => {
    expect(renderModelMetadata()).toBe("");
    expect(renderModelMetadata(undefined)).toBe("");
    expect(renderModelMetadata({})).toBe("");
  });

  it("returns model info when model is set", () => {
    const result = renderModelMetadata({ model: "gpt-4" });
    expect(result).toContain("gpt-4");
    expect(result).toContain("chat-model-metadata");
  });

  it("prefers responseModelId over model", () => {
    const result = renderModelMetadata({
      model: "base-model",
      responseModelId: "response-model",
    });
    expect(result).toContain("response-model");
    expect(result).not.toContain("base-model");
  });

  it("includes provider when set", () => {
    const result = renderModelMetadata({
      provider: "openai",
      model: "gpt-4",
    });
    expect(result).toContain("openai");
    expect(result).toContain("gpt-4");
  });

  it("escapes HTML in model name", () => {
    const result = renderModelMetadata({ model: '<script>alert("xss")</script>' });
    expect(result).not.toContain("<script>");
    expect(result).toContain("&lt;");
  });
});

// ─── role-settings.ts: resolve*RunSettings ─────────────────────────────────

import {
  resolveWritingRunSettings,
  resolveJudgmentRunSettings,
  resolveChatRunSettings,
  resolveBackgroundRunSettings,
  applyRuntimeModelDefaults,
} from "../role-settings.ts";
import type { AiSettings } from "../../settings.ts";
import type { ProviderConfig } from "../../providers/config.ts";

describe("resolveWritingRunSettings", () => {
  const mockConfig: ProviderConfig = {
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        sdkType: "anthropic",
        defaultBaseUrl: "https://api.anthropic.com",
        defaultModel: "claude-sonnet-4",
        models: [
          {
            id: "claude-sonnet-4",
            label: "Claude Sonnet 4",
            writing: {
              temperature: 0.7,
              promptScaffold: "light",
            },
          },
        ],
      },
    ],
  };
  const baseSettings: AiSettings = {
    provider: "anthropic",
    model: "claude-sonnet-4",
    temperature: 1.0,
    maxTokens: 8192,
    maxContextTokens: 64000,
  } as AiSettings;

  it("applies writing role profile temperature", () => {
    const resolved = resolveWritingRunSettings(mockConfig, baseSettings as AiSettings);
    // The writing profile has temperature 0.7, which should override the base 1.0
    expect(resolved.temperature).toBe(0.7);
  });

  it("applies writing role promptScaffold", () => {
    const resolved = resolveWritingRunSettings(mockConfig, baseSettings as AiSettings);
    expect(resolved.promptScaffold).toBe("light");
  });

  it("uses an explicitly selected writing model", () => {
    const config: ProviderConfig = {
      providers: [
        ...mockConfig.providers,
        {
          id: "openai",
          name: "OpenAI",
          sdkType: "openai",
          defaultBaseUrl: "https://api.openai.com",
          defaultModel: "gpt-writing",
          models: [{ id: "gpt-writing", label: "GPT Writing", temperature: 0.4 }],
        },
      ],
    };
    const resolved = resolveWritingRunSettings(config, {
      ...baseSettings,
      providerConfigs: {
        openai: { apiKey: "", baseUrl: "https://api.openai.com", model: "gpt-writing" },
      },
      writingModelSource: "custom",
      writingProvider: "openai",
      writingModel: "gpt-writing",
    } as AiSettings);
    expect(resolved.provider).toBe("openai");
    expect(resolved.model).toBe("gpt-writing");
    expect(resolved.temperature).toBe(0.4);
  });

  it("forces Thinking for DeepSeek V4 writing even when a profile disables it", () => {
    const config: ProviderConfig = {
      providers: [{
        id: "deepseek",
        name: "DeepSeek",
        sdkType: "deepseek",
        defaultBaseUrl: "https://api.deepseek.com",
        defaultModel: "deepseek-v4-pro",
        models: [{
          id: "deepseek-v4-pro",
          maxTokens: 384000,
          reasoningCapability: { kind: "deepseek" },
          writing: { deepseekThinkingEnabled: false },
        }],
      }],
    };
    const resolved = resolveWritingRunSettings(config, {
      ...baseSettings,
      provider: "deepseek",
      model: "deepseek-v4-pro",
      maxTokens: 384000,
    } as AiSettings);
    expect(resolved.deepseekThinkingEnabled).toBe(true);
    expect(resolved.maxTokens).toBe(384000);
  });

  it("forces Thinking for DeepSeek V4 through OpenCode Go", () => {
    const config: ProviderConfig = {
      providers: [{
        id: "opencode",
        name: "OpenCode Go",
        sdkType: "openai",
        defaultBaseUrl: "https://opencode.ai/zen/go/v1",
        defaultModel: "deepseek-v4-pro",
        models: [{ id: "deepseek-v4-pro", maxTokens: 32000 }],
      }],
    };
    const resolved = resolveWritingRunSettings(config, {
      ...baseSettings,
      provider: "opencode",
      model: "deepseek-v4-pro",
      maxTokens: 32000,
      deepseekThinkingEnabled: false,
    } as AiSettings);
    expect(resolved.deepseekThinkingEnabled).toBe(true);
    expect(resolved.maxTokens).toBe(32000);
  });

  it("keeps the configured output limit for thinking writing runs", () => {
    const config: ProviderConfig = {
      providers: [{
        id: "deepseek",
        name: "DeepSeek",
        sdkType: "deepseek",
        defaultBaseUrl: "https://api.deepseek.com",
        defaultModel: "deepseek-v4-pro",
        models: [{
          id: "deepseek-v4-pro",
          reasoningCapability: { kind: "deepseek" },
          writing: { deepseekThinkingEnabled: true },
        }],
      }],
    };
    const resolved = resolveWritingRunSettings(config, {
      ...baseSettings,
      provider: "deepseek",
      model: "deepseek-v4-pro",
      maxTokens: 32000,
    } as AiSettings);
    expect(resolved.maxTokens).toBe(32000);
  });

  it("keeps the configured output limit for exceptional non-thinking writing models", () => {
    const config: ProviderConfig = {
      providers: [{
        id: "openai",
        name: "OpenAI compatible",
        sdkType: "openai",
        defaultBaseUrl: "https://example.invalid/v1",
        defaultModel: "special-non-thinking-model",
        models: [{
          id: "special-non-thinking-model",
          maxTokens: 48000,
          reasoningCapability: { kind: "openai" },
          writing: { openaiReasoningEffort: "none" },
        }],
      }],
    };
    const resolved = resolveWritingRunSettings(config, {
      ...baseSettings,
      provider: "openai",
      model: "special-non-thinking-model",
      maxTokens: 48000,
    } as AiSettings);
    expect(resolved.openaiReasoningEffort).toBe("none");
    expect(resolved.maxTokens).toBe(48000);
  });
});

describe("resolveJudgmentRunSettings", () => {
  const mockConfig: ProviderConfig = {
    providers: [
      {
        id: "anthropic",
        name: "Anthropic",
        sdkType: "anthropic",
        defaultBaseUrl: "https://api.anthropic.com",
        defaultModel: "claude-sonnet-4",
        models: [
          {
            id: "claude-sonnet-4",
            label: "Claude Sonnet 4",
            judgment: {
              temperature: 0.3,
              promptScaffold: "full",
            },
          },
        ],
      },
    ],
  };
  const baseSettings: AiSettings = {
    provider: "anthropic",
    model: "claude-sonnet-4",
    temperature: 1.0,
    maxTokens: 8192,
    maxContextTokens: 64000,
    judgmentProvider: undefined,
    judgmentModel: undefined,
  } as AiSettings;

  it("applies judgment role profile temperature", () => {
    const resolved = resolveJudgmentRunSettings(mockConfig, baseSettings as AiSettings);
    expect(resolved.temperature).toBe(0.3);
  });

  it("applies judgment role promptScaffold", () => {
    const resolved = resolveJudgmentRunSettings(mockConfig, baseSettings as AiSettings);
    expect(resolved.promptScaffold).toBe("full");
  });
});

describe("applyRuntimeModelDefaults", () => {
  const baseSettings: AiSettings = {
    provider: "openai",
    model: "gpt-4o",
    temperature: 1.0,
    maxTokens: 4096,
    maxContextTokens: 32000,
  } as AiSettings;

  it("applies temperature from defaults when provided", () => {
    const resolved = applyRuntimeModelDefaults(
      baseSettings as AiSettings,
      { id: "gpt-4o", temperature: 0.5 },
      false,
    );
    expect(resolved.temperature).toBe(0.5);
  });

  it("preserves original maxTokens when applyTokenDefaults is false", () => {
    const resolved = applyRuntimeModelDefaults(
      baseSettings as AiSettings,
      { id: "gpt-4o", maxTokens: 16384 },
      false,
    );
    expect(resolved.maxTokens).toBe(4096);
  });

  it("applies token defaults when applyTokenDefaults is true", () => {
    const resolved = applyRuntimeModelDefaults(
      baseSettings as AiSettings,
      { id: "gpt-4o", maxTokens: 16384 },
      true,
    );
    expect(resolved.maxTokens).toBe(16384);
  });
});

describe("resolveChatRunSettings", () => {
  const mockConfig: ProviderConfig = {
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        sdkType: "openai",
        defaultBaseUrl: "https://api.openai.com",
        defaultModel: "gpt-4o",
        models: [{ id: "gpt-4o", label: "GPT-4o", temperature: 0.8 }],
      },
    ],
  };
  const baseSettings: AiSettings = {
    provider: "openai",
    model: "gpt-4o",
    temperature: 1.0,
    chatProvider: "openai",
    chatModel: "gpt-4o",
  } as AiSettings;

  it("applies model defaults", () => {
    const resolved = resolveChatRunSettings(mockConfig, baseSettings as AiSettings);
    expect(resolved.temperature).toBe(0.8);
  });
});

describe("resolveBackgroundRunSettings", () => {
  const mockConfig: ProviderConfig = {
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        sdkType: "openai",
        defaultBaseUrl: "https://api.openai.com",
        defaultModel: "gpt-4o-mini",
        models: [{ id: "gpt-4o-mini", label: "GPT-4o Mini", temperature: 0.3 }],
      },
    ],
  };
  const baseSettings: AiSettings = {
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 1.0,
    chatProvider: "openai",
    chatModel: "gpt-4o-mini",
    backgroundProvider: "openai",
    backgroundModel: "gpt-4o-mini",
  } as AiSettings;

  it("applies model defaults", () => {
    const resolved = resolveBackgroundRunSettings(mockConfig, baseSettings as AiSettings);
    expect(resolved.temperature).toBe(0.3);
  });
});

// ─── settings-modal.ts: preview pure functions ─────────────────────────────

// These are tested as close-to-pure functions by importing them directly.
// They take (config, resolved) or (resolved) and return strings.
import {
  describePreviewModel,
  describePreviewTemperature,
  describePreviewThinking,
  computeModelResolutionPreviewRows,
} from "../../ui/settings-modal.ts";
import type { ProviderConfig } from "../../providers/config.ts";

describe("describePreviewModel", () => {
  const config: ProviderConfig = {
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        sdkType: "openai",
        defaultBaseUrl: "https://api.openai.com",
        defaultModel: "gpt-4o",
        models: [{ id: "gpt-4o", label: "GPT-4o" }],
      },
    ],
  };

  it("uses provider name and model label", () => {
    const resolved = { provider: "openai", model: "gpt-4o" } as AiSettings;
    const result = describePreviewModel(config, resolved);
    expect(result).toBe("OpenAI / GPT-4o");
  });

  it("falls back to model id when no label", () => {
    const resolved = { provider: "unknown", model: "custom-model" } as AiSettings;
    const result = describePreviewModel(config, resolved);
    expect(result).toContain("custom-model");
  });
});

describe("describePreviewTemperature", () => {
  it("returns stringified temperature for normal providers", () => {
    const resolved = { provider: "openai", temperature: 0.7 } as AiSettings;
    expect(describePreviewTemperature(resolved)).toBe("0.7");
  });

  it("notes DeepSeek thinking ignores temperature", () => {
    const resolved = {
      provider: "deepseek",
      deepseekThinkingEnabled: true,
      temperature: 0.7,
    } as AiSettings;
    const result = describePreviewTemperature(resolved);
    expect(result).toContain("thinking");
  });

  it("returns normal temp when DeepSeek thinking is OFF", () => {
    const resolved = {
      provider: "deepseek",
      deepseekThinkingEnabled: false,
      temperature: 0.5,
    } as AiSettings;
    expect(describePreviewTemperature(resolved)).toBe("0.5");
  });
});

describe("describePreviewThinking", () => {
  it("returns dash for unknown providers", () => {
    const resolved = { provider: "unknown" } as AiSettings;
    expect(describePreviewThinking(resolved)).toBe("—");
  });

  it("describes OpenAI reasoning effort", () => {
    const resolved = {
      provider: "openai",
      openaiReasoningEffort: "high",
      reasoningCapability: { kind: "openai" },
    } as AiSettings;
    expect(describePreviewThinking(resolved)).toBe("high");
  });

  it("describes DeepSeek thinking ON", () => {
    const resolved = {
      provider: "deepseek",
      deepseekThinkingEnabled: true,
      reasoningCapability: { kind: "deepseek" },
    } as AiSettings;
    expect(describePreviewThinking(resolved)).toContain("thinking ON");
  });

  it("describes DeepSeek thinking OFF", () => {
    const resolved = {
      provider: "deepseek",
      deepseekThinkingEnabled: false,
      reasoningCapability: { kind: "deepseek" },
    } as AiSettings;
    expect(describePreviewThinking(resolved)).toBe("thinking OFF");
  });
});

describe("computeModelResolutionPreviewRows", () => {
  const config: ProviderConfig = {
    providers: [
      {
        id: "openai",
        name: "OpenAI",
        sdkType: "openai",
        defaultBaseUrl: "https://api.openai.com",
        defaultModel: "gpt-4o",
        models: [{ id: "gpt-4o", label: "GPT-4o", temperature: 0.5 }],
      },
    ],
  };
  const settings = {
    provider: "openai",
    model: "gpt-4o",
    temperature: 1.0,
    chatProvider: undefined,
    chatModel: undefined,
    judgmentProvider: undefined,
    judgmentModel: undefined,
    backgroundProvider: undefined,
    backgroundModel: undefined,
  } as AiSettings;

  it("returns 4 rows for a valid config", () => {
    const rows = computeModelResolutionPreviewRows(config, settings);
    expect(rows).toHaveLength(4);
  });

  it("first row is chat", () => {
    const rows = computeModelResolutionPreviewRows(config, settings);
    expect(rows![0].role).toBe("チャット");
  });

  it("writing and judgment have showScaffold true", () => {
    const rows = computeModelResolutionPreviewRows(config, settings);
    expect(rows![1].showScaffold).toBe(true);
    expect(rows![2].showScaffold).toBe(true);
  });

  it("returns undefined for null config", () => {
    expect(computeModelResolutionPreviewRows(undefined, settings)).toBeUndefined();
  });
});

// ─── promptScaffold extras in line-edit prompts ────────────────────────────

describe("buildLineEditReviewPrompt with promptScaffold extras", () => {
  const passage = "昨日の夕焼けは本当に美しかった。しかし彼の顔には影が落ちていた。";
  const context = "前の段落。\n[選択部分]\n後の段落。";

  it("includes full fiction direction when no extras", () => {
    const prompt = buildLineEditReviewPrompt(passage, context);
    expect(prompt).toContain("【日本語小説としての生成方針 — 全項目を必ず守る】");
    expect(prompt).toContain("【語りの型 — 書く前に必ず1つ判定する】");
  });

  it("includes full fiction direction when promptScaffold is 'full'", () => {
    const prompt = buildLineEditReviewPrompt(passage, context, undefined, undefined, { promptScaffold: "full" });
    expect(prompt).toContain("【日本語小説としての生成方針 — 全項目を必ず守る】");
  });

  it("includes light fiction direction when promptScaffold is 'light'", () => {
    const prompt = buildLineEditReviewPrompt(passage, context, undefined, undefined, { promptScaffold: "light" });
    expect(prompt).toContain("【日本語小説としての生成方針 — 要点】");
  });

  it("light scaffold produces shorter output than full scaffold", () => {
    const fullPrompt = buildLineEditReviewPrompt(passage, context, undefined, undefined, { promptScaffold: "full" });
    const lightPrompt = buildLineEditReviewPrompt(passage, context, undefined, undefined, { promptScaffold: "light" });
    expect(lightPrompt.length).toBeLessThan(fullPrompt.length);
  });
});

describe("buildLineEditRevisionPrompt with promptScaffold extras", () => {
  const passage = "彼は走った。息が切れていた。";
  const review = "【総合判定】要修正\n【修正必須】\n「彼は走った」— 動作の理由がない。";
  const context = "前の段落。\n[選択部分]\n後の段落。";

  it("includes full fiction direction when no extras", () => {
    const prompt = buildLineEditRevisionPrompt(passage, review, context);
    expect(prompt).toContain("【日本語小説としての生成方針 — 全項目を必ず守る】");
  });

  it("includes full fiction direction when promptScaffold is 'full'", () => {
    const prompt = buildLineEditRevisionPrompt(passage, review, context, undefined, undefined, { promptScaffold: "full" });
    expect(prompt).toContain("【日本語小説としての生成方針 — 全項目を必ず守る】");
  });

  it("includes light fiction direction when promptScaffold is 'light'", () => {
    const prompt = buildLineEditRevisionPrompt(passage, review, context, undefined, undefined, { promptScaffold: "light" });
    expect(prompt).toContain("【日本語小説としての生成方針 — 要点】");
  });

  it("light scaffold produces shorter output than full scaffold", () => {
    const fullPrompt = buildLineEditRevisionPrompt(passage, review, context, undefined, undefined, { promptScaffold: "full" });
    const lightPrompt = buildLineEditRevisionPrompt(passage, review, context, undefined, undefined, { promptScaffold: "light" });
    expect(lightPrompt.length).toBeLessThan(fullPrompt.length);
  });
});

describe("operation-specific light metacognition", () => {
  const extras = { promptScaffold: "light" as const };

  it("keeps creative pressure in creation prompts", () => {
    const prompt = buildContinuationPrompt("直前本文", undefined, "構想", undefined, extras);
    expect(prompt).toContain("才能の自己監視");
    expect(prompt).not.toContain("最小修正の監視");
  });

  it("uses minimum-change guidance for targeted repairs", () => {
    const prompt = buildTargetedRevisionPrompt(
      "ドラフト",
      "【総合判定】要修正",
      "直前本文",
      undefined,
      extras,
    );
    expect(prompt).toContain("最小修正の監視");
    expect(prompt).not.toContain("才能の自己監視");
  });

  it("protects untouched prose in full-repair prompts", () => {
    const prompt = buildContinuationRevisionPrompt(
      "ドラフト",
      "【総合判定】要修正",
      "直前本文",
      undefined,
      undefined,
      extras,
    );
    expect(prompt).toContain("全文出力時の局所編集監視");
    expect(prompt).toContain("未指摘部分を再創作せず");
    expect(prompt).not.toContain("才能の自己監視");
  });
});

describe("resolveConsistencyBudgets", () => {
  it("shrinks consistency material for a small context window", () => {
    const budgets = resolveConsistencyBudgets({ maxContextTokens: 8192 } as any);
    const total = Object.values(budgets).reduce((sum, value) => sum + value, 0);
    expect(total).toBeLessThanOrEqual((8192 - 6144) * 3);
    expect(budgets.fullText).toBeLessThan(120000);
  });

  it("keeps the established caps for a large context window", () => {
    const budgets = resolveConsistencyBudgets({ maxContextTokens: 1_000_000 } as any);
    expect(budgets.fullText).toBe(120000);
    expect(budgets.otherSummaries).toBe(20000);
  });
});
