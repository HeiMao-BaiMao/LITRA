import type { GenreIndexEntry } from "../../genres/schema.ts";

export interface GenreListActions {
  onSelect: (genreId: string) => void;
  onCreate: () => void;
  onRename: (genreId: string, name: string) => void;
  onDelete: (genreId: string) => void;
}

export function renderGenreList(
  container: HTMLElement,
  genres: GenreIndexEntry[],
  selectedGenreId: string | null,
  actions: GenreListActions,
): void {
  container.innerHTML = "";

  for (const genre of genres) {
    const el = document.createElement("div");
    el.className = `genre-list-item ${genre.id === selectedGenreId ? "selected" : ""}`;
    el.dataset.genreId = genre.id;

    const header = document.createElement("div");
    header.className = "genre-list-item-header";

    const name = document.createElement("span");
    name.className = "genre-list-item-name";
    name.textContent = genre.name;
    header.appendChild(name);

    const meta = document.createElement("div");
    meta.className = "genre-list-item-meta";
    meta.textContent = `資料 ${genre.sourceCount} · 知識 ${genre.acceptedKnowledgeCount} · 候補 ${genre.candidateKnowledgeCount} · チャット ${genre.chatThreadCount}`;

    const description = document.createElement("div");
    description.className = "genre-list-item-description";
    description.textContent = genre.description || "（説明なし）";

    el.appendChild(header);
    el.appendChild(meta);
    el.appendChild(description);

    el.addEventListener("click", () => actions.onSelect(genre.id));
    el.addEventListener("dblclick", () => {
      const newName = window.prompt("ジャンル名を変更", genre.name);
      if (newName && newName.trim() && newName.trim() !== genre.name) {
        actions.onRename(genre.id, newName.trim());
      }
    });

    const btnDelete = document.createElement("button");
    btnDelete.type = "button";
    btnDelete.className = "genre-list-item-delete";
    btnDelete.textContent = "削除";
    btnDelete.addEventListener("click", (event) => {
      event.stopPropagation();
      if (window.confirm(`「${genre.name}」を削除しますか？関連する資料・分析・知識・チャットも削除されます。`)) {
        actions.onDelete(genre.id);
      }
    });
    el.appendChild(btnDelete);

    container.appendChild(el);
  }
}
