import type { Genre } from "../../genres/schema.ts";

export interface GenreOverviewActions {
  onSave: (updates: {
    name?: string;
    aliases?: string[];
    description?: string;
    userDefinition?: string;
    notes?: string;
    tags?: string[];
  }) => void;
}

type GenreUpdate = Parameters<GenreOverviewActions["onSave"]>[0];

export function renderGenreOverview(
  container: HTMLElement,
  genre: Genre,
  actions: GenreOverviewActions,
): void {
  container.innerHTML = "";

  const form = document.createElement("form");
  form.className = "genre-overview-form";

  const fields: Array<{ label: string; key: keyof GenreUpdate; multiline: boolean }> = [
    { label: "ジャンル名", key: "name", multiline: false },
    { label: "別名（カンマ区切り）", key: "aliases", multiline: false },
    { label: "説明", key: "description", multiline: true },
    { label: "ユーザー定義", key: "userDefinition", multiline: true },
    { label: "補足メモ", key: "notes", multiline: true },
    { label: "タグ（カンマ区切り）", key: "tags", multiline: false },
  ];

  for (const field of fields) {
    const label = document.createElement("label");
    label.className = "genre-form-label";

    const span = document.createElement("span");
    span.textContent = field.label;
    label.appendChild(span);

    const input = field.multiline
      ? document.createElement("textarea")
      : document.createElement("input");
    input.className = "genre-form-input";

    const value = genre[field.key];
    if (Array.isArray(value)) {
      (input as HTMLInputElement | HTMLTextAreaElement).value = value.join(", ");
    } else {
      (input as HTMLInputElement | HTMLTextAreaElement).value = String(value ?? "");
    }

    input.addEventListener("change", () => {
      const updates: GenreUpdate = {};
      if (field.key === "aliases" || field.key === "tags") {
        updates[field.key] = (input as HTMLInputElement | HTMLTextAreaElement).value
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean);
      } else {
        updates[field.key] = (input as HTMLInputElement | HTMLTextAreaElement).value;
      }
      actions.onSave(updates);
    });

    label.appendChild(input);
    form.appendChild(label);
  }

  const meta = document.createElement("div");
  meta.className = "genre-overview-meta";
  meta.innerHTML = `
    <p>改訂番号: ${genre.revision}</p>
    <p>作成日時: ${new Date(genre.createdAt).toLocaleString()}</p>
    <p>更新日時: ${new Date(genre.updatedAt).toLocaleString()}</p>
  `;

  container.appendChild(form);
  container.appendChild(meta);
}
