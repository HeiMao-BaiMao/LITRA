import { marked } from "marked";
import DOMPurify from "dompurify";

const markedOptions = {
  gfm: true,
  breaks: true,
  async: false,
};

export function renderMarkdown(text: string): string {
  const rawHtml = marked.parse(text, markedOptions) as unknown as string;
  return DOMPurify.sanitize(rawHtml);
}

interface ToolCallDisplay {
  statusLabel: string;
  toolName: string;
  id?: string;
  state?: string;
  input?: string;
  output?: string;
  progress?: ToolProgressDisplay;
}

interface ToolProgressItem {
  phase: string;
  label: string;
  step?: number;
  totalSteps?: number;
  model?: string;
}

interface ToolProgressDisplay {
  current: ToolProgressItem;
  history: ToolProgressItem[];
}

function parseToolCallDisplay(content: string): ToolCallDisplay | null {
  const lines = content.split("\n");
  const header = lines[0]?.match(/^【ツール(.+?):\s*(.+?)】$/);
  if (!header) return null;

  const display: ToolCallDisplay = {
    statusLabel: header[1],
    toolName: header[2],
  };

  let section: "input" | "output" | null = null;
  const inputLines: string[] = [];
  const outputLines: string[] = [];

  for (const line of lines.slice(1)) {
    if (line.startsWith("状態:")) {
      display.state = line.slice("状態:".length).trim();
      section = null;
      continue;
    }
    if (line.startsWith("ID:")) {
      display.id = line.slice("ID:".length).trim();
      section = null;
      continue;
    }
    if (line.startsWith("進捗:")) {
      const raw = line.slice("進捗:".length).trim();
      try {
        display.progress = JSON.parse(raw) as ToolProgressDisplay;
      } catch {
        // 古いログや壊れた進捗情報は、カード全体を壊さず無視する。
      }
      section = null;
      continue;
    }
    if (line.startsWith("入力:")) {
      const rest = line.slice("入力:".length).trimStart();
      inputLines.push(rest);
      section = "input";
      continue;
    }
    if (line.startsWith("結果:")) {
      const rest = line.slice("結果:".length).trimStart();
      outputLines.push(rest);
      section = "output";
      continue;
    }
    if (section === "input") {
      inputLines.push(line);
    } else if (section === "output") {
      outputLines.push(line);
    }
  }

  display.input = inputLines.join("\n").trim();
  display.output = outputLines.join("\n").trim();
  return display;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function parseJsonLoose(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("（")) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function statusClass(label: string): string {
  if (label.includes("成功")) return "success";
  if (label.includes("失敗")) return "failure";
  if (label.includes("中断") || label.includes("未到達")) return "interrupted";
  if (label.includes("実行") || label.includes("入力生成中")) return "running";
  return "neutral";
}

function compactValue(value: unknown, fallback = "未指定"): string {
  if (typeof value === "string") return value.length > 0 ? value : fallback;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return fallback;
  return JSON.stringify(value);
}

function summarizeToolInput(toolName: string, input: unknown): string[] {
  const record = asRecord(input);
  if (!record) return [];

  if (toolName === "editEpisode") {
    const start = compactValue(record.startLine, "?");
    const end = compactValue(record.endLine, "?");
    const text = typeof record.replacementText === "string" ? record.replacementText : "";
    return [`${start}-${end}行`, `置換後 ${text.split("\n").length}行`];
  }

  if (toolName === "updateCharacter") {
    const updates = asRecord(record.updates);
    const fields = updates ? Object.keys(updates).join(", ") : "未指定";
    return [`ID: ${compactValue(record.characterId)}`, `項目: ${fields}`];
  }

  if (toolName === "updateWorldEntry") {
    const updates = asRecord(record.updates);
    const fields = updates ? Object.keys(updates).join(", ") : "未指定";
    return [`ID: ${compactValue(record.entryId)}`, `項目: ${fields}`];
  }

  if (toolName === "saveEpisodeSummary" || toolName === "saveEpisodeOneLiner") {
    return [`episodeId: ${compactValue(record.episodeId)}`];
  }

  if (toolName === "createCharacter") {
    return [
      `名前: ${compactValue(record.name)}`,
      ...(record.reading ? [`よみがな: ${compactValue(record.reading)}`] : []),
      ...(record.alias ? [`別名: ${compactValue(record.alias)}`] : []),
    ];
  }

  if (toolName === "createWorldEntry") {
    return [`名前: ${compactValue(record.name)}`, `カテゴリ: ${compactValue(record.category)}`];
  }

  if (toolName === "retrieveEpisode") {
    return [`episodeId: ${compactValue(record.episodeId)}`, `種別: ${compactValue(record.type)}`];
  }

  if (toolName === "searchEpisodes") {
    return [`検索: ${compactValue(record.query)}`, `上限: ${compactValue(record.limit, "既定")}`];
  }

  if ("episodeId" in record) return [`episodeId: ${compactValue(record.episodeId)}`];
  return [];
}

function summarizeToolOutput(toolName: string, output: unknown): string[] {
  const record = asRecord(output);
  if (!record) return [];

  const chips: string[] = [];
  if ("success" in record) chips.push(record.success ? "成功" : "失敗");
  if ("message" in record && typeof record.message === "string" && record.message.length > 0) {
    chips.push(record.message);
  }
  if ("appliedEdits" in record) chips.push(`適用 ${compactValue(record.appliedEdits)}件`);
  if ("editedLineRange" in record) {
    const range = asRecord(record.editedLineRange);
    if (range) chips.push(`${compactValue(range.startLine)}-${compactValue(range.endLine)}行`);
  }
  if ("replacementLineCount" in record) chips.push(`置換後 ${compactValue(record.replacementLineCount)}行`);
  if ("matches" in record && Array.isArray(record.matches)) chips.push(`一致 ${record.matches.length}件`);
  if ("totalLines" in record) chips.push(`全 ${compactValue(record.totalLines)}行`);
  if ("searchIndexUpdated" in record) chips.push(record.searchIndexUpdated ? "索引更新済み" : "索引未更新");
  if ("indexedDocuments" in record) chips.push(`索引 ${compactValue(record.indexedDocuments)}件`);
  if (toolName === "listCharacters" || toolName === "listWorldEntries") {
    const key = toolName === "listCharacters" ? "characters" : "entries";
    const list = record[key];
    if (Array.isArray(list)) chips.push(`${list.length}件`);
  }
  return chips;
}

function renderChips(chips: string[]): string {
  if (chips.length === 0) return "";
  return `<div class="tool-call-chips">${chips
    .map((chip) => `<span class="tool-call-chip">${escapeHtml(chip)}</span>`)
    .join("")}</div>`;
}

function deriveToolStatus(tool: ToolCallDisplay, output: unknown): string {
  if (tool.state) return tool.state;

  const record = asRecord(output);
  if (record && typeof record.success === "boolean") {
    return record.success ? "成功" : "失敗";
  }

  return tool.statusLabel;
}

const MAX_TOOL_VALUE_LENGTH = 800;

function stringifyToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";

  const json = JSON.stringify(value, null, 2);
  return typeof json === "string" ? json : String(value);
}

function renderToolValue(value: unknown): string {
  const text = stringifyToolValue(value);
  const truncated = text.length > MAX_TOOL_VALUE_LENGTH ? text.slice(0, MAX_TOOL_VALUE_LENGTH) + "…" : text;
  return `<pre class="tool-call-value" title="${escapeHtml(text)}"><code>${escapeHtml(truncated)}</code></pre>`;
}

function renderToolKeyValues(parsed: unknown): string | null {
  const record = asRecord(parsed);
  if (!record) return null;

  const entries = Object.entries(record);
  if (entries.length === 0) return renderToolValue(parsed);

  return `<div class="tool-call-kv-list">${entries
    .map(
      ([key, value]) => `<div class="tool-call-kv">
        <h4>${escapeHtml(key)}</h4>
        ${renderToolValue(value)}
      </div>`,
    )
    .join("")}</div>`;
}

function renderToolSection(title: string, raw: string | undefined): string {
  if (!raw) return "";
  const parsed = parseJsonLoose(raw);
  const rendered = parsed == null ? renderToolValue(raw) : (renderToolKeyValues(parsed) ?? renderToolValue(parsed));

  return `<div class="tool-call-section">
    <div class="tool-call-section-title">${escapeHtml(title)}</div>
    ${rendered}
  </div>`;
}

export function renderToolProgress(progress: ToolProgressDisplay | undefined): string {
  if (!progress?.current || !Array.isArray(progress.history)) return "";
  const currentPhase = progress.current.phase;
  const items = progress.history.map((item) => {
    const isCurrent = item.phase === currentPhase;
    const step = item.step != null && item.totalSteps != null ? `${item.step}/${item.totalSteps}` : "";
    return `<li class="tool-progress-item${isCurrent ? " current" : " completed"}">
      <span class="tool-progress-marker" aria-hidden="true"></span>
      <span class="tool-progress-label">${escapeHtml(item.label)}</span>
      ${step ? `<span class="tool-progress-step">${escapeHtml(step)}</span>` : ""}
      ${item.model ? `<span class="tool-progress-model">${escapeHtml(item.model)}</span>` : ""}
    </li>`;
  }).join("");
  return `<div class="tool-progress" aria-label="ツール実行の進捗"><ol>${items}</ol></div>`;
}

export interface MessageModelMetadata {
  provider?: string;
  model?: string;
  responseModelId?: string;
}

export function renderModelMetadata(metadata?: MessageModelMetadata): string {
  if (!metadata?.model && !metadata?.responseModelId) return "";
  const model = metadata.responseModelId || metadata.model || "";
  const label = metadata.provider ? `${metadata.provider} · ${model}` : model;
  return `<div class="chat-model-metadata" title="使用モデル">${escapeHtml(label)}</div>`;
}

function renderToolCallHtml(content: string, metadata?: MessageModelMetadata): string | null {
  const tool = parseToolCallDisplay(content);
  if (!tool) return null;

  const input = parseJsonLoose(tool.input ?? "");
  const output = parseJsonLoose(tool.output ?? "");
  const status = deriveToolStatus(tool, output);
  const chips = [...summarizeToolInput(tool.toolName, input), ...summarizeToolOutput(tool.toolName, output)];

  return `<details class="tool-call-card ${statusClass(status)}">
    <summary class="tool-call-summary">
      <div class="tool-call-header">
        <div class="tool-call-title">
          <span class="tool-call-icon">TOOL</span>
          <span class="tool-call-name">${escapeHtml(tool.toolName)}</span>
        </div>
        <span class="tool-call-status">${escapeHtml(status)}</span>
      </div>
      ${tool.id ? `<div class="tool-call-id">${escapeHtml(tool.id)}</div>` : ""}
      ${renderChips(chips)}
      ${renderToolProgress(tool.progress)}
    </summary>
    ${renderToolSection("入力", tool.input)}
    ${renderToolSection("結果", tool.output)}
    ${renderModelMetadata(metadata)}
  </details>`;
}

function renderMarkdownOrFallback(content: string): string {
  const html = renderMarkdown(content);
  if (html.trim().length === 0 && content.trim().length > 0) {
    console.warn("[litra:markdown] renderMarkdown returned empty for non-empty content:", JSON.stringify(content.slice(0, 200)));
    return `<pre class="chat-message-fallback"><code>${escapeHtml(content)}</code></pre>`;
  }
  return html;
}

function renderThinkingHtml(thinking: string | undefined, streaming: boolean): string {
  if (!thinking || thinking.trim().length === 0) return "";
  const body = renderMarkdownOrFallback(thinking);
  const label = streaming ? "思考中…" : "思考";
  return `<details class="thinking-panel${streaming ? " streaming" : ""}">
    <summary class="thinking-summary">${label}<span class="thinking-chars">${thinking.length}文字</span></summary>
    <div class="thinking-content">${body}</div>
  </details>`;
}

export function renderChatMessageHtml(
  element: HTMLElement,
  content: string,
  thinking?: string,
  metadata?: MessageModelMetadata,
): void {
  const prevThinking = element.querySelector<HTMLDetailsElement>("details.thinking-panel");
  const prevToolOpen = element.querySelector<HTMLDetailsElement>("details.tool-call-card")?.open ?? false;
  const hasThinking = Boolean(thinking && thinking.trim().length > 0);
  const contentEmpty = content.trim().length === 0;
  // 本文がまだ無く思考だけが流れている間はストリーミング表示扱いにする
  const streamingThinking = hasThinking && contentEmpty;

  // 思考パネルの開閉: ストリーミング中は自動で開き、本文が届いたら自動で畳む。
  // 手動での開閉は innerHTML の再構築をまたいで維持する。
  let thinkingOpen = false;
  let thinkingAuto = false;
  if (hasThinking) {
    if (!prevThinking) {
      thinkingOpen = streamingThinking;
      thinkingAuto = thinkingOpen;
    } else if (prevThinking.open) {
      const wasAuto = prevThinking.dataset.autoOpen === "true";
      thinkingAuto = wasAuto && streamingThinking;
      thinkingOpen = thinkingAuto || !wasAuto;
    }
  }

  const thinkingHtml = renderThinkingHtml(thinking, streamingThinking);
  const toolHtml = renderToolCallHtml(content, metadata);
  if (toolHtml != null) {
    element.innerHTML = DOMPurify.sanitize(`${thinkingHtml}${toolHtml}`);
    element.classList.toggle("tool-call-message", thinkingHtml.length === 0);
    element.classList.remove("chat-pending");
  } else {
    element.classList.remove("tool-call-message");
    // 本文も思考もまだ無い間は、待機中インジケーター(CSS の ::after)を表示する
    element.classList.toggle("chat-pending", contentEmpty && !hasThinking);
    const html = `${thinkingHtml}${renderMarkdownOrFallback(content)}${renderModelMetadata(metadata)}`;
    element.innerHTML = DOMPurify.sanitize(html);
  }

  const panel = element.querySelector<HTMLDetailsElement>("details.thinking-panel");
  if (panel) {
    panel.open = thinkingOpen;
    if (thinkingAuto) panel.dataset.autoOpen = "true";
    if (streamingThinking && thinkingOpen) {
      const body = panel.querySelector<HTMLElement>(".thinking-content");
      if (body) body.scrollTop = body.scrollHeight;
    }
  }
  if (prevToolOpen) {
    const tool = element.querySelector<HTMLDetailsElement>("details.tool-call-card");
    if (tool) tool.open = true;
  }
}
