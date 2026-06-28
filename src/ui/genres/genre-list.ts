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
    const item = document.createElement("div");
    item.className = "nav-episode-item genre-list-item";
    item.dataset.genreId = genre.id;
    item.classList.toggle("active", genre.id === selectedGenreId);
    item.classList.toggle("selected", genre.id === selectedGenreId);

    const titleContainer = document.createElement("div");
    titleContainer.className = "nav-episode-title-container genre-list-title-container";

    const title = document.createElement("button");
    title.type = "button";
    title.className = "nav-episode-title genre-list-item-name";
    title.textContent = genre.name || "（無題）";
    title.title = genre.description || "クリックで選択、ダブルクリックで名前を変更";
    title.addEventListener("click", () => actions.onSelect(genre.id));
    title.addEventListener("dblclick", () => {
      const newName = window.prompt("ジャンル名を変更", genre.name);
      if (newName && newName.trim() && newName.trim() !== genre.name) {
        actions.onRename(genre.id, newName.trim());
      }
    });

    const meta = document.createElement("div");
    meta.className = "genre-list-item-meta";
    meta.textContent = `資料 ${genre.sourceCount}・知識 ${genre.acceptedKnowledgeCount}・候補 ${genre.candidateKnowledgeCount}`;

    titleContainer.appendChild(title);
    titleContainer.appendChild(meta);

    const renameButton = document.createElement("button");
    renameButton.type = "button";
    renameButton.className = "nav-episode-edit genre-list-item-rename";
    renameButton.textContent = "✎";
    renameButton.title = "ジャンル名を変更";
    renameButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const newName = window.prompt("ジャンル名を変更", genre.name);
      if (newName && newName.trim() && newName.trim() !== genre.name) {
        actions.onRename(genre.id, newName.trim());
      }
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "nav-episode-delete genre-list-item-delete";
    deleteButton.textContent = "×";
    deleteButton.title = "ジャンルを削除";
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      actions.onDelete(genre.id);
    });

    item.appendChild(titleContainer);
    item.appendChild(renameButton);
    item.appendChild(deleteButton);
    container.appendChild(item);
  }
}
