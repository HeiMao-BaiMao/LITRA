import { bindAutoResize } from "./auto-resize.ts";
import type { ProjectMemo } from "../project/project-memo.ts";

export interface MemosEditorActions {
  onCreate: (title: string) => void;
  onUpdate: (id: string, updates: { title?: string; content?: string }) => void;
  onDelete: (id: string) => void;
  onSelect: (id: string | null) => void;
}

let updateTimeout: ReturnType<typeof setTimeout> | null = null;

function debounce(callback: () => void): void {
  if (updateTimeout) {
    clearTimeout(updateTimeout);
  }
  updateTimeout = setTimeout(callback, 400);
}

function renderList(
  memos: ProjectMemo[],
  activeId: string | null,
  onSelect: (id: string) => void,
  onDelete: (id: string) => void,
): HTMLElement {
  const list = document.createElement("div");
  list.className = "memos-list";

  for (const memo of memos) {
    const row = document.createElement("div");
    row.className = "memos-list-item";
    if (memo.id === activeId) {
      row.classList.add("active");
    }

    const nameBtn = document.createElement("button");
    nameBtn.type = "button";
    nameBtn.className = "memos-list-name";
    nameBtn.textContent = memo.title || "（無題）";
    nameBtn.addEventListener("click", () => onSelect(memo.id));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "memos-list-delete";
    deleteBtn.textContent = "×";
    deleteBtn.title = "削除";
    deleteBtn.addEventListener("click", () => {
      if (window.confirm(`「${memo.title || "（無題）"}」を削除しますか？`)) {
        onDelete(memo.id);
      }
    });

    row.appendChild(nameBtn);
    row.appendChild(deleteBtn);
    list.appendChild(row);
  }

  return list;
}

function createDetail(
  memo: ProjectMemo,
  onUpdate: (id: string, updates: { title?: string; content?: string }) => void,
): HTMLElement {
  const container = document.createElement("div");
  container.className = "memos-detail";
  container.dataset.memoId = memo.id;

  const titleRow = document.createElement("div");
  titleRow.className = "memos-title-row";

  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "memos-title-input";
  titleInput.placeholder = "メモタイトル";
  titleInput.value = memo.title;
  titleInput.addEventListener("input", () => {
    debounce(() => onUpdate(memo.id, { title: titleInput.value }));
  });
  titleRow.appendChild(titleInput);

  const textarea = document.createElement("textarea");
  textarea.className = "memos-content-textarea";
  textarea.placeholder = "内容を自由に書いてください...";
  textarea.value = memo.content;
  textarea.spellcheck = false;
  textarea.addEventListener("input", () => {
    debounce(() => onUpdate(memo.id, { content: textarea.value }));
  });

  container.appendChild(titleRow);
  container.appendChild(textarea);

  bindAutoResize(textarea, 30);

  return container;
}

function buildEditor(
  memos: ProjectMemo[],
  activeId: string | null,
  actions: MemosEditorActions,
): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.className = "memos-editor";

  const sidebar = document.createElement("div");
  sidebar.className = "memos-editor-sidebar";

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "memos-add-button";
  addBtn.textContent = "＋ 新しいメモ";
  addBtn.addEventListener("click", () => {
    const title = window.prompt("メモのタイトルを入力してください");
    if (title === null) return;
    const trimmed = title.trim();
    if (!trimmed) {
      window.alert("タイトルを入力してください");
      return;
    }
    actions.onCreate(trimmed);
  });

  sidebar.appendChild(addBtn);
  sidebar.appendChild(
    renderList(
      memos,
      activeId,
      (id) => actions.onSelect(id),
      (id) => actions.onDelete(id),
    ),
  );

  const detail = document.createElement("div");
  detail.className = "memos-editor-detail";

  const header = document.createElement("div");
  header.className = "memos-detail-header";

  const title = document.createElement("h3");
  title.textContent = "メモ";
  header.appendChild(title);

  detail.appendChild(header);

  const selected = memos.find((m) => m.id === activeId);
  if (selected) {
    detail.appendChild(createDetail(selected, actions.onUpdate));
  } else {
    const empty = document.createElement("div");
    empty.className = "memos-empty";
    empty.textContent = "メモを選択または作成してください";
    detail.appendChild(empty);
  }

  wrapper.appendChild(sidebar);
  wrapper.appendChild(detail);
  return wrapper;
}

function updateList(
  container: HTMLElement,
  memos: ProjectMemo[],
  activeId: string | null,
  actions: MemosEditorActions,
): void {
  const sidebar = container.querySelector(":scope > .memos-editor-sidebar");
  if (!sidebar) return;
  const oldList = sidebar.querySelector(":scope > .memos-list");
  const newList = renderList(
    memos,
    activeId,
    (id) => actions.onSelect(id),
    (id) => actions.onDelete(id),
  );
  if (oldList) {
    sidebar.replaceChild(newList, oldList);
  } else {
    sidebar.appendChild(newList);
  }
}

function updateDetail(
  container: HTMLElement,
  memo: ProjectMemo | undefined,
  onUpdate: (id: string, updates: { title?: string; content?: string }) => void,
): void {
  const detail = container.querySelector(":scope > .memos-editor-detail");
  if (!detail) return;

  const existing = detail.querySelector<HTMLElement>(":scope > .memos-detail");
  if (!memo) {
    if (existing) {
      existing.remove();
      const empty = document.createElement("div");
      empty.className = "memos-empty";
      empty.textContent = "メモを選択または作成してください";
      detail.appendChild(empty);
    }
    return;
  }

  if (existing && existing.dataset.memoId === memo.id) {
    // 同じメモが選択されている場合はフォーカスを失わないよう値だけ更新
    const titleInput = existing.querySelector<HTMLInputElement>(".memos-title-input");
    const textarea = existing.querySelector<HTMLTextAreaElement>(".memos-content-textarea");
    if (titleInput && document.activeElement !== titleInput) {
      titleInput.value = memo.title;
    }
    if (textarea && document.activeElement !== textarea) {
      textarea.value = memo.content;
      // 高さを再調整
      textarea.style.height = "auto";
      textarea.style.height = `${Math.min(textarea.scrollHeight, 30 * 24)}px`;
    }
    return;
  }

  if (existing) existing.remove();
  const empty = detail.querySelector(":scope > .memos-empty");
  if (empty) empty.remove();
  detail.appendChild(createDetail(memo, onUpdate));
}

export function renderMemosEditor(
  memos: ProjectMemo[],
  activeId: string | null,
  actions: MemosEditorActions,
  container: HTMLElement,
): void {
  const existing = container.querySelector<HTMLElement>(":scope > .memos-editor");

  if (!existing) {
    container.innerHTML = "";
    container.appendChild(buildEditor(memos, activeId, actions));
    return;
  }

  updateList(existing, memos, activeId, actions);
  const selected = memos.find((m) => m.id === activeId);
  updateDetail(existing, selected, actions.onUpdate);
}
