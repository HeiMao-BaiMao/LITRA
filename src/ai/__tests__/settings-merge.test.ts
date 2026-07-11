/**
 * 設定マージヘルパーの純関数テスト。
 *
 * saveAndCloseSettings で使われる pickDefinedOrFallback が、
 * モーダルが明示的に undefined(チャット欄に同期)を返したケースを
 * 正しく反映できることを確認する。
 */
import { describe, it, expect } from "bun:test";
import { pickDefinedOrFallback } from "../../settings-merge.ts";

describe("pickDefinedOrFallback", () => {
  it("returns source value when key exists with a defined value", () => {
    expect(pickDefinedOrFallback({ x: 42 }, { x: 0 }, "x")).toBe(42);
  });

  it("returns fallback value when key does not exist at all in source", () => {
    expect(pickDefinedOrFallback({}, { x: 0 }, "x")).toBe(0);
  });

  it("returns source undefined when key exists and is explicitly undefined", () => {
    // This is the key bug scenario: modal returns backgroundProvider: undefined
    expect(pickDefinedOrFallback({ x: undefined }, { x: 42 }, "x")).toBeUndefined();
  });

  it("returns source null when key exists and is null", () => {
    expect(pickDefinedOrFallback({ x: null }, { x: 42 }, "x")).toBeNull();
  });

  it("returns source empty string when key exists", () => {
    expect(pickDefinedOrFallback({ x: "" }, { x: "default" }, "x")).toBe("");
  });

  it("returns source false when key exists", () => {
    expect(pickDefinedOrFallback({ x: false }, { x: true }, "x")).toBe(false);
  });

  it("returns source zero when key exists", () => {
    expect(pickDefinedOrFallback({ x: 0 }, { x: 1 }, "x")).toBe(0);
  });

  it("uses fallback when source object has no own properties", () => {
    const source = Object.create(null);
    // source has no 'x' property
    expect(pickDefinedOrFallback(source, { x: "fallback" }, "x")).toBe("fallback");
  });

  it("works with string keys matching AiSettings fields", () => {
    interface TestSettings {
      provider: string;
      backgroundProvider?: string;
      backgroundModel?: string;
      chatProvider?: string;
      chatModel?: string;
    }

    const modalReturn: Partial<TestSettings> = {
      backgroundProvider: undefined,  // user selected "sync with chat"
      backgroundModel: undefined,      // user selected "sync with chat"
    };
    const currentSettings: TestSettings = {
      provider: "openai",
      backgroundProvider: "anthropic",  // old lingering value
      backgroundModel: "claude-opus-4", // old lingering value
      chatProvider: "openai",
      chatModel: "gpt-4",
    };

    // After merge with the fix, background fields should be cleared
    expect(pickDefinedOrFallback(modalReturn, currentSettings, "backgroundProvider")).toBeUndefined();
    expect(pickDefinedOrFallback(modalReturn, currentSettings, "backgroundModel")).toBeUndefined();

    // Chat fields not in modal output → should fall through to currentSettings
    expect(pickDefinedOrFallback(modalReturn, currentSettings, "chatProvider")).toBe("openai");
    expect(pickDefinedOrFallback(modalReturn, currentSettings, "chatModel")).toBe("gpt-4");
  });

  it("respects source value when backgroundProvider is set to a specific provider", () => {
    const source: Record<string, unknown> = { backgroundProvider: "deepseek" };
    const fallback = { backgroundProvider: "anthropic", backgroundModel: "claude-3" };
    expect(pickDefinedOrFallback(source, fallback, "backgroundProvider")).toBe("deepseek");
  });
});
