import type { ModelMessage } from "ai";
import { limitPromptText } from "../ai/prompts.ts";
import { buildGenreChatSystemPrompt } from "./prompts.ts";
import type {
  Genre,
  GenreChatContextSnapshot,
  GenreChatDocument,
  GenreChatMessage,
  GenreKnowledgeDocument,
} from "./schema.ts";

const CONTEXT_CHAR_PER_TOKEN = 1.6;
const CONTEXT_OVERHEAD_TOKENS = 2048;
const DEFAULT_MAX_CONTEXT_TOKENS = 65536;
const DEFAULT_MAX_OUTPUT_TOKENS = 8192;

interface ContextBudgets {
  systemPrompt: number;
  knowledgeSummary: number;
  candidateSummary: number;
  chatHistory: number;
  chatMessage: number;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getContextBudgets(
  maxContextTokens: number,
  maxOutputTokens: number,
): ContextBudgets {
  const reservedTokens = Math.min(
    Math.max(maxOutputTokens, 1024) + CONTEXT_OVERHEAD_TOKENS,
    Math.floor(maxContextTokens * 0.5),
  );
  const usableTokens = Math.max(2048, maxContextTokens - reservedTokens);
  const usableChars = Math.max(4096, Math.floor(usableTokens * CONTEXT_CHAR_PER_TOKEN));
  const scaled = (ratio: number, min: number, max: number) =>
    Math.floor(clampNumber(usableChars * ratio, min, max));

  return {
    systemPrompt: scaled(0.12, 2000, 240000),
    knowledgeSummary: scaled(0.12, 2000, 240000),
    candidateSummary: scaled(0.05, 1000, 100000),
    chatHistory: scaled(0.6, 4000, 1200000),
    chatMessage: scaled(0.08, 1500, 160000),
  };
}

function formatKnowledgeSummary(document: GenreKnowledgeDocument, maxChars: number): string {
  const activeItems = document.items.filter((item) => item.status === "active");
  const lines = activeItems.map((item) => {
    const tags = [item.category, item.importance];
    return `[${tags.join(" ")}] ${item.title}: ${item.statement}`;
  });
  return limitPromptText(lines.join("\n"), maxChars, "head");
}

function formatCandidateSummary(candidates: GenreKnowledgeDocument["candidates"], maxChars: number): string {
  const pending = candidates.filter((c) => c.status === "pending");
  const lines = pending.map((c) => `[${c.category}] ${c.title}: ${c.statement}`);
  return limitPromptText(lines.join("\n"), maxChars, "head");
}

export interface BuildGenreChatMessagesOptions {
  maxContextTokens?: number;
  maxOutputTokens?: number;
  includePendingCandidates?: boolean;
}



export function buildGenreChatMessages(
  genre: Genre,
  knowledge: GenreKnowledgeDocument,
  messages: GenreChatMessage[],
  options: BuildGenreChatMessagesOptions = {},
): ModelMessage[] {
  const maxContextTokens = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const budgets = getContextBudgets(maxContextTokens, maxOutputTokens);

  const systemPrompt = limitPromptText(
    buildGenreChatSystemPrompt(genre, knowledge, options.includePendingCandidates ? knowledge.candidates : []),
    budgets.systemPrompt,
    "head",
  );

  const knowledgeSummary = formatKnowledgeSummary(knowledge, budgets.knowledgeSummary);
  const candidateSummary = options.includePendingCandidates
    ? formatCandidateSummary(knowledge.candidates, budgets.candidateSummary)
    : "";

  const contextNote = [
    knowledgeSummary ? `【採用済みジャンル知識】\n${knowledgeSummary}` : "",
    candidateSummary ? `【未確認知識候補】\n${candidateSummary}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const naturalMessages = messages.filter(
    (message): message is GenreChatMessage & { role: "user" | "assistant" } =>
      message.content.trim().length > 0 &&
      !message.excludeFromContext &&
      message.role !== "tool",
  );

  const selected: (GenreChatMessage & { role: "user" | "assistant" })[] = [];
  let totalChars = 0;

  for (let i = naturalMessages.length - 1; i >= 0; i--) {
    const message = naturalMessages[i];
    const content = limitPromptText(message.content, budgets.chatMessage, "middle");
    const nextTotal = totalChars + content.length;

    if (selected.length > 0 && nextTotal > budgets.chatHistory) {
      break;
    }

    selected.unshift({ ...message, content });
    totalChars = nextTotal;
  }

  const modelMessages: ModelMessage[] = [{ role: "system", content: systemPrompt }];
  if (contextNote) {
    modelMessages.push({ role: "system", content: contextNote });
  }

  for (const message of selected) {
    modelMessages.push({ role: message.role, content: message.content });
  }

  return modelMessages;
}

export function createContextSnapshot(
  genre: Genre,
  document: GenreChatDocument,
  provider: string,
  model: string,
): GenreChatContextSnapshot {
  const messageIds = document.messages.map((message) => message.id);
  return {
    id: crypto.randomUUID(),
    genreId: genre.id,
    threadId: document.thread.id,
    genreRevision: genre.revision,
    knowledgeItemIds: [],
    candidateIds: [],
    sourceIds: document.messages.flatMap((m) => m.referencedSourceIds ?? []),
    segmentIds: document.messages.flatMap((m) => m.referencedSegmentIds ?? []),
    historyMessageIds: messageIds,
    usedThreadSummary: false,
    provider,
    model,
    createdAt: new Date().toISOString(),
  };
}

export function buildChatMessagesText(messages: GenreChatMessage[]): string {
  return messages
    .map((message) => {
      const roleLabel = message.role === "user" ? "ユーザー" : "AI";
      return `--- ${roleLabel} ---\n${message.content}`;
    })
    .join("\n\n");
}
