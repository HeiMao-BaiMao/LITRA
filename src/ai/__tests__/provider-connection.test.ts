import { describe, expect, test } from "bun:test";
import {
  resolveProviderConnection,
  type ProviderConfig,
  type ProviderEntry,
} from "../../providers/config.ts";
import defaultProviders from "../../providers/default-providers.json" with { type: "json" };

const provider: ProviderEntry = {
  id: "multi",
  name: "Multi protocol provider",
  sdkType: "openai",
  defaultBaseUrl: "https://gateway.example",
  defaultModel: "gpt-model",
  defaultConnection: "responses",
  connections: [
    {
      id: "responses",
      apiType: "openai-responses",
      baseUrl: "https://gateway.example/v1",
    },
    {
      id: "messages",
      apiType: "anthropic-messages",
      baseUrl: "https://messages.gateway.example/v1",
    },
  ],
  models: [
    { id: "gpt-model" },
    { id: "claude-model", connection: "messages" },
  ],
};

describe("resolveProviderConnection", () => {
  test("モデルごとに異なるAPI Typeと接続先を選択する", () => {
    expect(resolveProviderConnection(provider, "gpt-model")?.apiType).toBe("openai-responses");
    expect(resolveProviderConnection(provider, "claude-model")).toEqual({
      id: "messages",
      apiType: "anthropic-messages",
      baseUrl: "https://messages.gateway.example/v1",
    });
  });

  test("保存された既定URLはモデル固有の接続先を上書きしない", () => {
    expect(
      resolveProviderConnection(provider, "claude-model", "https://gateway.example")?.baseUrl,
    ).toBe("https://messages.gateway.example/v1");
  });

  test("ユーザーが変更したURLは接続先を上書きする", () => {
    expect(
      resolveProviderConnection(provider, "claude-model", "https://custom.example/v1")?.baseUrl,
    ).toBe("https://custom.example/v1");
  });

  test("既定設定の全モデルが有効な接続定義へ解決される", () => {
    const config = defaultProviders as ProviderConfig;
    for (const entry of config.providers) {
      const connectionIds = new Set(entry.connections?.map((connection) => connection.id));
      expect(connectionIds.has(entry.defaultConnection)).toBe(true);
      for (const model of entry.models ?? []) {
        if (model.connection) expect(connectionIds.has(model.connection)).toBe(true);
        expect(resolveProviderConnection(entry, model.id)).toBeDefined();
      }
    }
  });

  test("OpenCode の API Type はモデル名判定ではなく connection 設定で切り替わる", () => {
    const config = defaultProviders as ProviderConfig;
    const openCode = config.providers.find((entry) => entry.id === "opencode");
    expect(resolveProviderConnection(openCode, "deepseek-v4-flash")?.apiType).toBe("openai-chat");
    expect(resolveProviderConnection(openCode, "minimax-m3")?.apiType).toBe(
      "anthropic-messages",
    );
  });
});
