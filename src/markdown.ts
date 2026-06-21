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
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
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
    return [`名前: ${compactValue(record.name)}`];
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

function renderToolCallHtml(content: string): string | null {
  const tool = parseToolCallDisplay(content);
  if (!tool) return null;

  const input = parseJsonLoose(tool.input ?? "");
  const output = parseJsonLoose(tool.output ?? "");
  const status = deriveToolStatus(tool, output);
  const chips = [...summarizeToolInput(tool.toolName, input), ...summarizeToolOutput(tool.toolName, output)];

  return `<div class="tool-call-card ${statusClass(status)}">
    <div class="tool-call-header">
      <div class="tool-call-title">
        <span class="tool-call-icon">TOOL</span>
        <span class="tool-call-name">${escapeHtml(tool.toolName)}</span>
      </div>
      <span class="tool-call-status">${escapeHtml(status)}</span>
    </div>
    ${tool.id ? `<div class="tool-call-id">${escapeHtml(tool.id)}</div>` : ""}
    ${renderChips(chips)}
    ${renderToolSection("入力", tool.input)}
    ${renderToolSection("結果", tool.output)}
  </div>`;
}

export function renderChatMessageHtml(element: HTMLElement, content: string): void {
  const toolHtml = renderToolCallHtml(content);
  if (toolHtml != null) {
    element.innerHTML = DOMPurify.sanitize(toolHtml);
    element.classList.add("tool-call-message");
    return;
  }

  element.classList.remove("tool-call-message");
  const html = renderMarkdown(content);
  if (html.trim().length === 0 && content.trim().length > 0) {
    console.warn("[phenex:markdown] renderMarkdown returned empty for non-empty content:", JSON.stringify(content.slice(0, 200)));
    element.textContent = content;
  } else {
    element.innerHTML = html;
  }
}
