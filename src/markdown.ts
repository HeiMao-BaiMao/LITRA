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

export function renderChatMessageHtml(element: HTMLElement, content: string): void {
  const html = renderMarkdown(content);
  if (html.trim().length === 0 && content.trim().length > 0) {
    console.warn("[phenex:markdown] renderMarkdown returned empty for non-empty content:", JSON.stringify(content.slice(0, 200)));
    element.textContent = content;
  } else {
    element.innerHTML = html;
  }
}
