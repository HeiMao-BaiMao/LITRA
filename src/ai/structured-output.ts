import { z } from "zod";
import type { AiSettings } from "../settings.ts";
import { streamRustText, type RustToolDefinition } from "./rust-transport.ts";

interface GenerateStructuredObjectOptions<T> {
  schema: z.ZodType<T>;
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  settings: AiSettings;
  [key: string]: unknown;
}

interface GenerateStructuredObjectResult<T> {
  object: T;
}

const STRUCTURED_OUTPUT_TOOL_NAME = "submit_structured_output";

/**
 * 全 wire protocol で共通に使える単一の強制ツール呼び出しとして構造化出力を得る。
 * response_format の互換性差を避け、接続・ストリーム解析は Rust core に集約する。
 */
export async function generateStructuredObject<T>(
  options: GenerateStructuredObjectOptions<T>,
): Promise<GenerateStructuredObjectResult<T>> {
  const startedAt = performance.now();
  console.log("[litra:structured-output] START", {
    provider: options.settings.provider,
    model: options.settings.model,
  });

  const tool: RustToolDefinition = {
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    description:
      "Submit the structured output. Call this tool exactly once with the response that matches the required schema. Do not include any other text.",
    inputSchema: z.toJSONSchema(options.schema, { target: "draft-07" }),
  };
  const result = await streamRustText(options.settings, {
    system: options.system ?? "",
    prompt: options.prompt,
    tools: [tool],
    toolChoice: "required",
    toolChoiceName: STRUCTURED_OUTPUT_TOOL_NAME,
    maxOutputTokens: options.maxOutputTokens ?? options.settings.maxTokens,
    abortSignal: options.abortSignal,
    onChunk: () => {},
  });
  const call = result.toolCalls.find((candidate) => candidate.toolName === STRUCTURED_OUTPUT_TOOL_NAME);
  if (!call) {
    throw new Error(
      `generateStructuredObject: model did not call "${STRUCTURED_OUTPUT_TOOL_NAME}" (finishReason=${result.finishReason})`,
    );
  }
  const parsed = options.schema.safeParse(call.input);
  if (!parsed.success) {
    throw new Error(`generateStructuredObject: structured output validation failed: ${z.prettifyError(parsed.error)}`);
  }

  console.log("[litra:structured-output] COMPLETE", {
    provider: options.settings.provider,
    model: options.settings.model,
    durationMs: Math.round(performance.now() - startedAt),
  });
  console.log("[litra:structured-output] OUTPUT", parsed.data);
  return { object: parsed.data };
}
