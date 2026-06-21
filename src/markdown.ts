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
  const template = document.createElement("template");
  template.textContent = value;
  return template.innerHTML;
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

function stringifyToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";

  const json = JSON.stringify(value, null, 2);
  return typeof json === "string" ? json : String(value);
}

function renderToolValue(value: unknown): string {
  return `<pre class="tool-call-value"><code>${escapeHtml(stringifyToolValue(value))}</code></pre>`;
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

  return `<details class="tool-call-section" open>
    <summary>${escapeHtml(title)}</summary>
    ${rendered}
  </details>`;
}

function renderToolCallHtml(content: string): string | null {
  const tool = parseToolCallDisplay(content);
  if (!tool) return null;

  const state = tool.state || tool.statusLabel;

  return `<div class="tool-call-card ${statusClass(tool.statusLabel)}">
    <div class="tool-call-header">
      <div class="tool-call-title">
        <span class="tool-call-icon">TOOL</span>
        <span class="tool-call-name">${escapeHtml(tool.toolName)}</span>
      </div>
      <span class="tool-call-status">${escapeHtml(state)}</span>
    </div>
    ${tool.id ? `<div class="tool-call-id">${escapeHtml(tool.id)}</div>` : ""}
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
