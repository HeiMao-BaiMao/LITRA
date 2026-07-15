import { describe, expect, test } from "bun:test";
import type { AiSettings } from "../../settings.ts";
import type { ResolvedProviderConnection } from "../../providers/config.ts";
import { buildRustTextRequest, type RustTextStreamOptions } from "../rust-transport.ts";

const connection: ResolvedProviderConnection = {
  id: "chat",
  apiType: "openai-chat",
  baseUrl: "https://api.deepseek.com",
};

function request(
  settings: Partial<AiSettings>,
  overrides: Partial<RustTextStreamOptions> = {},
) {
  return buildRustTextRequest(
    "request-id",
    {
      provider: "deepseek",
      model: "deepseek-chat",
      apiKey: "test",
      temperature: 0.7,
      maxTokens: 1024,
      deepseekThinkingEnabled: true,
      ...settings,
    } as AiSettings,
    connection,
    {
      system: "",
      prompt: "test",
      maxOutputTokens: 128,
      onChunk: () => {},
      ...overrides,
    },
  );
}

describe("buildRustTextRequest overrides", () => {
  test("DeepSeek thinking uses configured mode and omits sampling", () => {
    const result = request({});
    expect(result.thinkingEnabled).toBe(true);
    expect(result.temperature).toBeUndefined();
  });

  test("background verification can disable thinking and override temperature", () => {
    const result = request({}, { thinkingEnabled: false, temperature: 0.1 });
    expect(result.thinkingEnabled).toBe(false);
    expect(result.temperature).toBe(0.1);
  });
});
