import { generateObject, generateText, tool, type LanguageModel } from "ai";
import type { z } from "zod";
import { OPENCODE_GO_ANTHROPIC_MODELS } from "./provider.ts";
import type { AiSettings } from "../settings.ts";

/**
 * OpenCode Go プロバイダは OpenAI 互換経路のときに
 * `response_format: json_schema + strict: true` を処理できず 400 を返す。
 * OpenCode 本家の実装にならい、人工ツールを定義して
 * `toolChoice: { type: "tool", toolName }` で強制呼び出しすることで
 * `response_format` を一切使わずに構造化出力を得る。
 *
 * 戻り値は `{ object: T }` 形式で、既存 `generateObject` の `result.object`
 * アクセスと互換。
 */

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

interface GenerateStructuredObjectOptions<T> {
  model: LanguageModel;
  schema: z.ZodType<T>;
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  abortSignal?: AbortSignal;
  providerOptions?: Record<string, JsonObject>;
  maxRetries?: number;
  headers?: Record<string, string | undefined>;
  /** プロバイダ判定に使う。OpenCode Go の OpenAI 互換経路でツール強制呼び出しに切り替える。 */
  settings: AiSettings;
}

interface GenerateStructuredObjectResult<T> {
  object: T;
}

const STRUCTURED_OUTPUT_TOOL_NAME = "submit_structured_output";

export async function generateStructuredObject<T>(
  options: GenerateStructuredObjectOptions<T>,
): Promise<GenerateStructuredObjectResult<T>> {
  const startedAt = performance.now();
  console.log("[litra:structured-output] START", {
    provider: options.settings.provider,
    model: options.settings.model,
  });
  const isOpenCodeOpenAiCompatible =
    options.settings.provider === "opencode" &&
    !OPENCODE_GO_ANTHROPIC_MODELS.has(options.settings.model);

  const { settings: _settings, providerOptions, schema, ...sharedOptions } = options;
  void _settings;

  if (!isOpenCodeOpenAiCompatible) {
    // 通常プロバイダは generateObject の response_format 経路で OK。
    const result = await generateObject({
      ...sharedOptions,
      schema,
      ...(providerOptions ? { providerOptions } : {}),
    });
    const object = result.object as T;
    console.log("[litra:structured-output] COMPLETE", {
      provider: options.settings.provider,
      model: options.settings.model,
      durationMs: Math.round(performance.now() - startedAt),
    });
    console.log("[litra:structured-output] OUTPUT", object);
    return { object };
  }

  // OpenCode Go (OpenAI 互換経路) は response_format を送らない。
  // 人工ツールを定義し、toolChoice: { type: "tool", toolName } で必ず呼ばせる。
  const structuredTool = tool({
    description:
      "Submit the structured output. Call this tool exactly once with the response that matches the required schema. Do not include any other text.",
    inputSchema: schema,
  });

  const result = await generateText({
    ...sharedOptions,
    tools: { [STRUCTURED_OUTPUT_TOOL_NAME]: structuredTool },
    toolChoice: { type: "tool", toolName: STRUCTURED_OUTPUT_TOOL_NAME },
    ...(providerOptions ? { providerOptions } : {}),
  });

  const call = result.toolCalls.find(
    (c) => c.toolName === STRUCTURED_OUTPUT_TOOL_NAME,
  );
  if (!call) {
    throw new Error(
      `generateStructuredObject: model did not call "${STRUCTURED_OUTPUT_TOOL_NAME}" (finishReason=${result.finishReason})`,
    );
  }

  // tool({ inputSchema: zodSchema }) で作られたツールの input は
  // Zod パース済みオブジェクト（DynamicToolCall ではない通常の TypedToolCall）。
  // Dynamic 経路になるのは MCP などの実行時ツールのみで、ここでは該当しない。
  const object = (call as { input: T }).input;
  console.log("[litra:structured-output] COMPLETE", {
    provider: options.settings.provider,
    model: options.settings.model,
    durationMs: Math.round(performance.now() - startedAt),
  });
  console.log("[litra:structured-output] OUTPUT", object);
  return { object };
}
