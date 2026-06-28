import type { GenreChatThread } from "../../genres/schema.ts";

export interface ThreadListActions {
  onSelect: (threadId: string) => void;
  onCreate: () => void;
  onRename: (threadId: string, title: string) => void;
  onArchive: (threadId: string) => void;
  onDelete: (threadId: string) => void;
}

export function renderThreadList(
  container: HTMLElement,
  threads: GenreChatThread[],
  currentThreadId: string | null,
  actions: ThreadListActions,
): void {
  container.innerHTML = "";

  const header = document.createElement("div");
  header.className = "thread-list-header";

  const btnCreate = document.createElement("button");
  btnCreate.type = "button";
  btnCreate.textContent = "＋ 新規スレッド";
  btnCreate.addEventListener("click", actions.onCreate);
  header.appendChild(btnCreate);

  container.appendChild(header);

  for (const thread of threads) {
    const el = document.createElement("div");
    el.className = `thread-list-item ${thread.id === currentThreadId ? "selected" : ""}`;
    el.textContent = thread.title;

    el.addEventListener("click", () => actions.onSelect(thread.id));
    el.addEventListener("dblclick", () => {
      const newTitle = window.prompt("スレッド名を変更", thread.title);
      if (newTitle && newTitle.trim() && newTitle.trim() !== thread.title) {
        actions.onRename(thread.id, newTitle.trim());
      }
    });

    const actionsEl = document.createElement("div");
    actionsEl.className = "thread-item-actions";

    const btnArchive = document.createElement("button");
    btnArchive.type = "button";
    btnArchive.textContent = "アーカイブ";
    btnArchive.addEventListener("click", (event) => {
      event.stopPropagation();
      actions.onArchive(thread.id);
    });

    const btnDelete = document.createElement("button");
    btnDelete.type = "button";
    btnDelete.textContent = "削除";
    btnDelete.addEventListener("click", (event) => {
      event.stopPropagation();
      if (window.confirm(`「${thread.title}」を削除しますか？`)) {
        actions.onDelete(thread.id);
      }
    });

    actionsEl.appendChild(btnArchive);
    actionsEl.appendChild(btnDelete);
    el.appendChild(actionsEl);

    container.appendChild(el);
  }
}
