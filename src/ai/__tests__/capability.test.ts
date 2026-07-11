/**
 * Model capability resolution and provider option building tests.
 * These are pure logic tests that don't require DOM or Tauri APIs.
 */
import { describe, it, expect } from "bun:test";

// We test the pure functions directly
import {
  getModelCapability,
  getEffectiveCapability,
  copilotCacheToCapability,
  modelSupportsReasoning,
  canDisableThinking,
  isThinkingAlwaysOn,
  supportsEffortSelector,
  supportsBudgetInput,
  getControlType,
  getSupportedEfforts,
} from "../capability.ts";
import { buildProviderOptions } from "../provider-options.ts";
import type { ProviderModelDefaults, ReasoningCapability } from "../../providers/config.ts";

// ---- Fixtures ----

const openaiDefaults: ProviderModelDefaults = {
  id: "gpt-5.6-sol",
  openaiReasoningEffort: "medium",
  reasoningCapability: {
    kind: "openai",
    supportedEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
  },
};

const fableDefaults: ProviderModelDefaults = {
  id: "claude-fable-5",
  anthropicThinkingEnabled: false,
  reasoningCapability: {
    kind: "anthropic-adaptive",
    supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    display: "summarized",
  },
};

const opusBudgetDefaults: ProviderModelDefaults = {
  id: "claude-opus-4-8",
  anthropicThinkingEnabled: false,
  reasoningCapability: {
    kind: "anthropic-budget",
    canDisable: true,
    supportsBudget: true,
    minBudget: 1000,
    maxBudget: 64000,
  },
};

const copilotGptDefaults: ProviderModelDefaults = {
  id: "gpt-5.6-sol",
  openaiReasoningEffort: "medium",
  reasoningCapability: {
    kind: "openai",
    supportedEfforts: ["none", "minimal", "low", "medium", "high", "xhigh"],
  },
};

const copilotFableDefaults: ProviderModelDefaults = {
  id: "claude-fable-5",
  reasoningCapability: {
    kind: "anthropic-adaptive",
    supportedEfforts: ["low", "medium", "high"],
    display: "summarized",
  },
};

// ---- getModelCapability with defaults ----

describe("getModelCapability with defaults", () => {
  it("uses curated reasoningCapability from defaults when provided", () => {
    const cap = getModelCapability("openai", "gpt-5.6-sol", openaiDefaults);
    expect(cap?.kind).toBe("openai");
    expect(cap?.supportedEfforts).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"]);
  });

  it("uses curated anthropic-adaptive from defaults", () => {
    const cap = getModelCapability("anthropic", "claude-fable-5", fableDefaults);
    expect(cap?.kind).toBe("anthropic-adaptive");
    expect(cap?.display).toBe("summarized");
    expect(cap?.supportedEfforts).toContain("max");
  });

  it("uses curated anthropic-budget from defaults", () => {
    const cap = getModelCapability("anthropic", "claude-opus-4-8", opusBudgetDefaults);
    expect(cap?.kind).toBe("anthropic-budget");
    expect(cap?.canDisable).toBe(true);
    expect(cap?.supportsBudget).toBe(true);
    expect(cap?.minBudget).toBe(1000);
    expect(cap?.maxBudget).toBe(64000);
  });

  it("falls back to heuristic when no reasoningCapability in defaults", () => {
    const defaultsNoCap: ProviderModelDefaults = { id: "gpt-5.6-sol", temperature: 1.0 };
    const cap = getModelCapability("openai", "gpt-5.6-sol", defaultsNoCap);
    expect(cap?.kind).toBe("openai");
  });

  it("returns undefined for non-reasoning model even with defaults", () => {
    const noReasoningDefaults: ProviderModelDefaults = { id: "gpt-3.5-turbo" };
    const cap = getModelCapability("llamacpp", "gpt-3.5-turbo", noReasoningDefaults);
    expect(cap).toBeUndefined();
  });
});

// ---- getEffectiveCapability ----

describe("getEffectiveCapability", () => {
  it("returns curated capability when no Copilot cache provided", () => {
    const cap = getEffectiveCapability("openai", "gpt-5.6-sol", openaiDefaults);
    expect(cap?.kind).toBe("openai");
  });

  it("prefers Copilot cached entry over curated defaults", () => {
    const cap = getEffectiveCapability("github-copilot", "claude-fable-5", copilotFableDefaults, () => ({
      id: "claude-fable-5",
      endpoint: "messages",
      adaptiveThinking: true,
      reasoningEffort: ["low", "medium", "high", "xhigh", "max"],
    }));
    expect(cap?.kind).toBe("anthropic-adaptive");
    // Cache says effort includes xhigh and max
    expect(cap?.supportedEfforts).toContain("max");
  });

  it("falls back to curated when Copilot cache entry missing", () => {
    const cap = getEffectiveCapability("github-copilot", "claude-fable-5", copilotFableDefaults, () => undefined);
    expect(cap?.kind).toBe("anthropic-adaptive");
    // Fallback should match curated: ["low", "medium", "high"]
    expect(cap?.supportedEfforts).toEqual(["low", "medium", "high"]);
  });

  it("returns undefined for non-reasoning Copilot models", () => {
    const cap = getEffectiveCapability("github-copilot", "gpt-3.5-turbo", undefined, () => undefined);
    expect(cap).toBeUndefined();
  });
});

// ---- copilotCacheToCapability ----

describe("copilotCacheToCapability", () => {
  it("converts messages adaptive cache entry", () => {
    const cap = copilotCacheToCapability({
      id: "claude-fable-5",
      endpoint: "messages",
      adaptiveThinking: true,
      reasoningEffort: ["low", "medium", "high"],
    });
    expect(cap?.kind).toBe("anthropic-adaptive");
    expect(cap?.display).toBe("summarized");
    expect(cap?.supportedEfforts).toEqual(["low", "medium", "high"]);
  });

  it("converts messages budget cache entry", () => {
    const cap = copilotCacheToCapability({
      id: "claude-sonnet-4-6",
      endpoint: "messages",
      maxThinkingBudget: 32000,
      minThinkingBudget: 1000,
    });
    expect(cap?.kind).toBe("anthropic-budget");
    expect(cap?.canDisable).toBe(true);
    expect(cap?.supportsBudget).toBe(true);
    expect(cap?.minBudget).toBe(1000);
    expect(cap?.maxBudget).toBe(32000);
  });

  it("converts responses cache entry with reasoning effort", () => {
    const cap = copilotCacheToCapability({
      id: "gpt-5.6-sol",
      endpoint: "responses",
      reasoningEffort: ["none", "low", "medium", "high"],
    });
    expect(cap?.kind).toBe("openai");
    expect(cap?.supportedEfforts).toEqual(["none", "low", "medium", "high"]);
  });

  it("returns undefined for undefined entry", () => {
    expect(copilotCacheToCapability(undefined)).toBeUndefined();
  });

  it("returns undefined for chat endpoint (no reasoning info)", () => {
    const cap = copilotCacheToCapability({
      id: "gpt-4",
      endpoint: "chat",
    });
    expect(cap).toBeUndefined();
  });
});

// ---- buildProviderOptions ----

describe("buildProviderOptions", () => {
  it("returns undefined when no reasoning effort for OpenAI", () => {
    const opts = buildProviderOptions({
      provider: "openai",
      model: "gpt-5.6-sol",
      openaiReasoningEffort: undefined,
    } as any);
    expect(opts).toBeUndefined();
  });

  it("returns OpenAI reasoning effort options", () => {
    const opts = buildProviderOptions({
      provider: "openai",
      model: "gpt-5.6-sol",
      openaiReasoningEffort: "medium",
    } as any);
    expect(opts).toEqual({
      openai: {
        reasoningEffort: "medium",
        reasoningSummary: "detailed",
      },
    });
  });

  it("returns Anthropic adaptive thinking options for Fable", () => {
    const opts = buildProviderOptions({
      provider: "anthropic",
      model: "claude-fable-5",
      anthropicThinkingEffort: "high",
      reasoningCapability: {
        kind: "anthropic-adaptive",
        supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
        display: "summarized",
      },
    } as any);
    expect(opts).toEqual({
      anthropic: {
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
      },
    });
  });

  it("Anthropic adaptive omits display when not summarized", () => {
    const opts = buildProviderOptions({
      provider: "anthropic",
      model: "claude-fable-5",
      anthropicThinkingEffort: "low",
      reasoningCapability: {
        kind: "anthropic-adaptive",
        supportedEfforts: ["low", "medium", "high"],
        // no display field → should not emit display
      },
    } as any);
    // Ensure no display:"detailed" (blocker 5)
    expect(opts).toEqual({
      anthropic: {
        thinking: { type: "adaptive" },
        effort: "low",
      },
    });
  });

  it("Anthropic adaptive returns undefined when no effort set", () => {
    const opts = buildProviderOptions({
      provider: "anthropic",
      model: "claude-fable-5",
      anthropicThinkingEffort: undefined,
      reasoningCapability: { kind: "anthropic-adaptive" },
    } as any);
    expect(opts).toBeUndefined();
  });

  it("returns Anthropic budget thinking ON options", () => {
    const opts = buildProviderOptions({
      provider: "anthropic",
      model: "claude-opus-4-8",
      anthropicThinkingEnabled: true,
      anthropicThinkingBudget: 8000,
      reasoningCapability: { kind: "anthropic-budget" },
    } as any);
    expect(opts).toEqual({
      anthropic: {
        thinking: { type: "enabled", budgetTokens: 8000 },
      },
    });
  });

  it("Anthropic budget sends explicit disabled when thinking is OFF", () => {
    const opts = buildProviderOptions({
      provider: "anthropic",
      model: "claude-opus-4-8",
      anthropicThinkingEnabled: false,
      anthropicThinkingBudget: undefined,
      reasoningCapability: { kind: "anthropic-budget", canDisable: true },
    } as any);
    expect(opts).toEqual({ anthropic: { thinking: { type: "disabled" } } });
  });

  it("returns Copilot GPT OpenAI options with include field", () => {
    const opts = buildProviderOptions({
      provider: "github-copilot",
      model: "gpt-5.6-sol",
      openaiReasoningEffort: "medium",
      reasoningCapability: { kind: "openai" },
    } as any);
    expect(opts).toEqual({
      openai: {
        reasoningEffort: "medium",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      },
    });
  });

  it("returns Copilot Fable adaptive options", () => {
    const opts = buildProviderOptions({
      provider: "github-copilot",
      model: "claude-fable-5",
      anthropicThinkingEffort: "high",
      reasoningCapability: {
        kind: "anthropic-adaptive",
        supportedEfforts: ["low", "medium", "high"],
        display: "summarized",
      },
    } as any);
    expect(opts).toEqual({
      anthropic: {
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
      },
    });
  });

  it("returns Copilot Claude budget options", () => {
    const opts = buildProviderOptions({
      provider: "github-copilot",
      model: "claude-sonnet-4-6",
      anthropicThinkingEnabled: true,
      anthropicThinkingBudget: 16000,
      reasoningCapability: { kind: "anthropic-budget" },
    } as any);
    expect(opts).toEqual({
      anthropic: {
        thinking: { type: "enabled", budgetTokens: 16000 },
      },
    });
  });

  it("returns DeepSeek thinking enabled options", () => {
    const opts = buildProviderOptions({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      deepseekReasoningEffort: "high",
      deepseekThinkingEnabled: undefined, // default = enabled
    } as any);
    expect(opts).toEqual({
      deepseek: {
        thinking: { type: "enabled" },
        reasoningEffort: "high",
      },
    });
  });

  it("returns DeepSeek thinking disabled options when tools enabled", () => {
    const opts = buildProviderOptions({
      provider: "deepseek",
      model: "deepseek-v4-flash",
    } as any, true);
    expect(opts).toEqual({
      deepseek: { thinking: { type: "disabled" } },
    });
  });

  it("returns Google Gemini thinking options", () => {
    const opts = buildProviderOptions({
      provider: "google",
      model: "gemini-3.5-flash",
      googleThinkingLevel: "high",
    } as any);
    expect(opts).toEqual({
      google: {
        thinkingConfig: { includeThoughts: true, thinkingLevel: "high" },
      },
    });
  });

  it("returns undefined for non-reasoning providers", () => {
    const opts = buildProviderOptions({
      provider: "llamacpp",
      model: "gpt-3.5-turbo",
    } as any);
    expect(opts).toBeUndefined();
  });
});

// ---- Existing capability tests (preserved) ----

describe("getModelCapability (existing)", () => {
  it("returns undefined for non-reasoning models", () => {
    expect(getModelCapability("llamacpp", "gpt-3.5-turbo")).toBeUndefined();
    expect(getModelCapability("sakura", "gpt-oss-120b")).toBeUndefined();
    expect(getModelCapability("google", "gemma-4-26b-a4b-it")).toBeUndefined();
    expect(getModelCapability("google", "gemini-2.0-flash")).toBeUndefined();
  });

  it("returns openai capability for OpenAI models", () => {
    const cap = getModelCapability("openai", "gpt-5.6-sol");
    expect(cap?.kind).toBe("openai");
    expect(cap?.supportedEfforts).toContain("none");
    expect(cap?.supportedEfforts).toContain("xhigh");
  });

  it("returns openai capability for Codex GPT models", () => {
    const cap = getModelCapability("codex", "gpt-5.6-sol");
    expect(cap?.kind).toBe("openai");
    expect(cap?.supportedEfforts).toContain("medium");
  });

  it("returns anthropic-adaptive for Fable 5", () => {
    const cap = getModelCapability("anthropic", "claude-fable-5");
    expect(cap?.kind).toBe("anthropic-adaptive");
    expect(cap?.display).toBe("summarized");
    expect(cap?.supportedEfforts).toContain("max");
  });

  it("returns anthropic-budget for Claude Opus/Sonnet", () => {
    const cap = getModelCapability("anthropic", "claude-opus-4-8");
    expect(cap?.kind).toBe("anthropic-budget");
    expect(cap?.canDisable).toBe(true);
    expect(cap?.supportsBudget).toBe(true);
  });

  it("returns deepseek capability for DeepSeek models", () => {
    const cap = getModelCapability("deepseek", "deepseek-v4-flash");
    expect(cap?.kind).toBe("deepseek");
    expect(cap?.supportedEfforts).toContain("max");
    expect(cap?.canDisable).toBe(true);
  });

  it("returns google capability for Gemini 3 models", () => {
    const cap = getModelCapability("google", "gemini-3.5-flash");
    expect(cap?.kind).toBe("google");
    expect(cap?.supportedEfforts).toContain("high");
  });

  it("handles Copilot models correctly", () => {
    const capGpt = getModelCapability("github-copilot", "gpt-5.6-sol");
    expect(capGpt?.kind).toBe("openai");

    const capFable = getModelCapability("github-copilot", "claude-fable-5");
    expect(capFable?.kind).toBe("anthropic-adaptive");

    const capSonnet = getModelCapability("github-copilot", "claude-sonnet-4-6");
    expect(capSonnet?.kind).toBe("anthropic-budget");
  });
});

describe("modelSupportsReasoning", () => {
  it("returns true when capability exists", () => {
    expect(modelSupportsReasoning({ kind: "openai" })).toBe(true);
  });
  it("returns false when capability is undefined", () => {
    expect(modelSupportsReasoning(undefined)).toBe(false);
  });
});

describe("canDisableThinking", () => {
  it("returns true when canDisable is set", () => {
    expect(canDisableThinking({ kind: "deepseek", canDisable: true })).toBe(true);
  });
  it("returns false for adaptive models", () => {
    expect(canDisableThinking({ kind: "anthropic-adaptive" })).toBe(false);
  });
});

describe("isThinkingAlwaysOn", () => {
  it("returns true for adaptive models", () => {
    expect(isThinkingAlwaysOn({ kind: "anthropic-adaptive" })).toBe(true);
  });
  it("returns false for budget models", () => {
    expect(isThinkingAlwaysOn({ kind: "anthropic-budget" })).toBe(false);
  });
});

describe("supportsEffortSelector", () => {
  it("returns true when supportedEfforts is non-empty and kind is not google", () => {
    expect(supportsEffortSelector({ kind: "openai", supportedEfforts: ["low", "high"] })).toBe(true);
    expect(supportsEffortSelector({ kind: "anthropic-adaptive", supportedEfforts: ["low", "high"] })).toBe(true);
  });
  it("returns false for google (uses thinkingLevel instead)", () => {
    expect(supportsEffortSelector({ kind: "google", supportedEfforts: ["low", "high"] })).toBe(false);
  });
  it("returns false when no supportedEfforts", () => {
    expect(supportsEffortSelector({ kind: "openai" })).toBe(false);
  });
  it("returns false when undefined", () => {
    expect(supportsEffortSelector(undefined)).toBe(false);
  });
});

describe("supportsBudgetInput", () => {
  it("returns true when supportsBudget is true", () => {
    expect(supportsBudgetInput({ kind: "anthropic-budget", supportsBudget: true })).toBe(true);
  });
  it("returns false when not set", () => {
    expect(supportsBudgetInput({ kind: "anthropic-adaptive" })).toBe(false);
  });
});

describe("getControlType", () => {
  it("maps each kind correctly", () => {
    expect(getControlType({ kind: "openai" })).toBe("openai-reasoning-effort");
    expect(getControlType({ kind: "anthropic-adaptive" })).toBe("anthropic-adaptive");
    expect(getControlType({ kind: "anthropic-budget" })).toBe("anthropic-budget");
    expect(getControlType({ kind: "deepseek" })).toBe("deepseek");
    expect(getControlType({ kind: "google" })).toBe("google-thinking-level");
  });
  it("returns none for undefined", () => {
    expect(getControlType(undefined)).toBe("none");
  });
});

describe("getSupportedEfforts", () => {
  it("returns empty array for undefined", () => {
    expect(getSupportedEfforts(undefined)).toEqual([]);
  });
  it("returns supported efforts when defined", () => {
    expect(getSupportedEfforts({ kind: "openai", supportedEfforts: ["none", "low", "high"] })).toEqual(["none", "low", "high"]);
  });
});
