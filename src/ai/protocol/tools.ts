import { z } from "zod";
import type { ModelMessage } from "./messages.ts";

export interface ToolExecutionOptions {
  toolCallId: string;
  messages: ModelMessage[];
  abortSignal?: AbortSignal;
}

export interface ToolDefinition<
  InputSchema extends z.ZodType = z.ZodType,
  Output = unknown,
> {
  description?: string;
  inputSchema: InputSchema;
  execute?: (
    input: z.infer<InputSchema>,
    options: ToolExecutionOptions,
  ) => Output | Promise<Output> | AsyncIterable<Output>;
}

export type ToolSet = Record<string, ToolDefinition<z.ZodType, unknown>>;

export function tool<InputSchema extends z.ZodType, Output>(
  definition: ToolDefinition<InputSchema, Output>,
): ToolDefinition<InputSchema, Output> {
  return definition;
}
