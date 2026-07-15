import { asSchema, type ModelMessage, type ToolSet } from "ai";
import type { RustToolCall, RustToolDefinition } from "./rust-transport.ts";

export async function serializeRustTools(tools: ToolSet): Promise<RustToolDefinition[]> {
  return await Promise.all(
    Object.entries(tools).map(async ([name, tool]) => ({
      name,
      description: tool.description ?? "",
      inputSchema: await asSchema(tool.inputSchema).jsonSchema,
    })),
  );
}

export interface RustToolExecutionResult {
  responseMessages: ModelMessage[];
  resultCount: number;
  errorCount: number;
}

export async function executeRustToolCalls(
  tools: ToolSet,
  calls: RustToolCall[],
  requestMessages: ModelMessage[],
  assistantText: string,
  abortSignal?: AbortSignal,
  onEvent?: (event:
    | { type: "call"; toolCallId: string; toolName: string; input: unknown }
    | { type: "result"; toolCallId: string; toolName: string; input: unknown; output: unknown }
    | { type: "error"; toolCallId: string; toolName: string; input: unknown; error: unknown }
  ) => void,
): Promise<RustToolExecutionResult> {
  const assistantParts: Array<Record<string, unknown>> = [];
  if (assistantText) assistantParts.push({ type: "text", text: assistantText });
  const resultParts: Array<Record<string, unknown>> = [];
  let resultCount = 0;
  let errorCount = 0;

  for (const call of calls) {
    abortSignal?.throwIfAborted();
    const definition = tools[call.toolName];
    assistantParts.push({
      type: "tool-call",
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
    });
    onEvent?.({ type: "call", ...call });
    try {
      if (!definition?.execute) throw new Error(`実行できないAIツールです: ${call.toolName}`);
      const schema = asSchema(definition.inputSchema);
      const validation = schema.validate ? await schema.validate(call.input) : { success: true as const, value: call.input };
      if (!validation.success) throw validation.error;
      const execute = definition.execute as (
        input: unknown,
        options: { toolCallId: string; messages: ModelMessage[]; abortSignal?: AbortSignal },
      ) => unknown;
      let output = await execute(validation.value, {
        toolCallId: call.toolCallId,
        messages: requestMessages,
        abortSignal,
      });
      if (isAsyncIterable(output)) {
        let last: unknown;
        for await (const value of output) last = value;
        output = last;
      }
      resultParts.push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "json", value: toJsonValue(output) },
      });
      resultCount++;
      onEvent?.({ type: "result", ...call, output });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resultParts.push({
        type: "tool-result",
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: "error-text", value: message },
      });
      errorCount++;
      onEvent?.({ type: "error", ...call, error });
    }
  }

  const responseMessages: ModelMessage[] = [];
  if (assistantParts.length > 0) {
    responseMessages.push({ role: "assistant", content: assistantParts } as ModelMessage);
  }
  if (resultParts.length > 0) {
    responseMessages.push({ role: "tool", content: resultParts } as ModelMessage);
  }
  return { responseMessages, resultCount, errorCount };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  return typeof value === "object" && value !== null && Symbol.asyncIterator in value;
}

function toJsonValue(value: unknown): unknown {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}
