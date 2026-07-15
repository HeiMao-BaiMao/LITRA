import { describe, expect, test } from "bun:test";
import { tool, type ModelMessage, type ToolSet } from "ai";
import { z } from "zod";
import { executeRustToolCalls, serializeRustTools } from "../rust-tools.ts";

const tools: ToolSet = {
  lookup: tool({
    description: "Look up a value",
    inputSchema: z.object({ id: z.string() }),
    execute: async ({ id }) => ({ id, name: "answer" }),
  }),
};

describe("Rust tool bridge", () => {
  test("AI SDK tool schemaをRust request用JSON Schemaへ変換する", async () => {
    const serialized = await serializeRustTools(tools);
    expect(serialized[0].name).toBe("lookup");
    expect(serialized[0].inputSchema).toMatchObject({
      type: "object",
      properties: { id: { type: "string" } },
    });
  });

  test("Rustで復元したtool callを検証・実行して履歴を構築する", async () => {
    const messages: ModelMessage[] = [{ role: "user", content: "lookup" }];
    const result = await executeRustToolCalls(
      tools,
      [{ toolCallId: "call-1", toolName: "lookup", input: { id: "42" } }],
      messages,
      "",
    );
    expect(result.resultCount).toBe(1);
    expect(result.errorCount).toBe(0);
    expect(result.responseMessages[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: "call-1", toolName: "lookup" }],
    });
    expect(result.responseMessages[1]).toMatchObject({
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: "call-1",
        output: { type: "json", value: { id: "42", name: "answer" } },
      }],
    });
  });

  test("不正なtool inputを実行せずerror resultにする", async () => {
    const result = await executeRustToolCalls(
      tools,
      [{ toolCallId: "call-2", toolName: "lookup", input: { id: 42 } }],
      [],
      "",
    );
    expect(result.resultCount).toBe(0);
    expect(result.errorCount).toBe(1);
    expect(result.responseMessages[1]).toMatchObject({
      role: "tool",
      content: [{ output: { type: "error-text" } }],
    });
  });
});
