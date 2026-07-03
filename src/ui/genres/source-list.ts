import type { GenreSource } from "../../genres/schema.ts";

export interface SourceListActions {
  onSelect: (sourceId: string) => void;
  onImport: () => void;
  onView: (sourceId: string) => void;
  onDelete: (sourceId: string) => void;
}

const ROLE_LABELS: Record<GenreSource["sourceRole"], string> = {
  core_example: "中核例",
  partial_example: "部分例",
  boundary_example: "境界例",
  counterexample: "反例",
  historical_reference: "歴史参考",
  critical_reference: "批評参考",
  user_interpretation: "ユーザー解釈",
};

const STATUS_LABELS: Record<GenreSource["analysisStatus"], string> = {
  not_analyzed: "未分析",
  queued: "待機中",
  running: "分析中",
  completed: "完了",
  failed: "失敗",
  cancelled: "中断",
  stale: "陳腐化",
};

export function renderSourceList(
  container: HTMLElement,
  sources: GenreSource[],
  actions: SourceListActions,
): void {
  container.innerHTML = "";

  const header = document.createElement("div");
  header.className = "source-list-header";

  const btnImport = document.createElement("button");
  btnImport.type = "button";
  btnImport.textContent = "＋ 資料を追加";
  btnImport.addEventListener("click", actions.onImport);
  header.appendChild(btnImport);

  container.appendChild(header);

  for (const source of sources) {
    const el = document.createElement("div");
    el.className = "source-list-item";

    const title = document.createElement("div");
    title.className = "source-list-item-title";
    title.textContent = source.title;

    const meta = document.createElement("div");
    meta.className = "source-list-item-meta";
    meta.textContent = `${ROLE_LABELS[source.sourceRole]} · ${source.sourceType} · ${source.characterCount}文字 · ${source.segmentCount}セグメント · ${STATUS_LABELS[source.analysisStatus]}`;

    const actionsEl = document.createElement("div");
    actionsEl.className = "source-list-item-actions";

    const btnView = document.createElement("button");
    btnView.type = "button";
    btnView.textContent = "表示";
    btnView.addEventListener("click", () => actions.onView(source.id));

    const btnDelete = document.createElement("button");
    btnDelete.type = "button";
    btnDelete.textContent = "削除";
    btnDelete.addEventListener("click", () => {
      if (window.confirm(`「${source.title}」を削除しますか？`)) {
        actions.onDelete(source.id);
      }
    });

    actionsEl.appendChild(btnView);
    actionsEl.appendChild(btnDelete);

    el.appendChild(title);
    el.appendChild(meta);
    el.appendChild(actionsEl);
    el.addEventListener("click", () => actions.onSelect(source.id));

    container.appendChild(el);
  }
}

export function renderSourceEditor(
  container: HTMLElement,
  source: GenreSource | null,
  content: string,
  onSave: (input: {
    title: string;
    author: string;
    sourceType: GenreSource["sourceType"];
    sourceRole: GenreSource["sourceRole"];
    preference: GenreSource["preference"];
    sourceNote: string;
    userInterpretation: string;
    content: string;
  }) => void,
): void {
  container.innerHTML = "";

  const form = document.createElement("form");
  form.className = "source-editor-form";

  const titleInput = createTextField("資料名", source?.title ?? "");
  const authorInput = createTextField("著者", source?.author ?? "");
  const typeSelect = createSelectField(
    "資料種別",
    [
      { value: "fiction", label: "小説" },
      { value: "fiction_excerpt", label: "小説抜粋" },
      { value: "critical_essay", label: "批評文" },
      { value: "genre_explanation", label: "ジャンル解説" },
      { value: "user_note", label: "ユーザーノート" },
      { value: "other", label: "その他" },
    ],
    source?.sourceType ?? "other",
  );
  const roleSelect = createSelectField(
    "役割",
    [
      { value: "core_example", label: "中核例" },
      { value: "partial_example", label: "部分例" },
      { value: "boundary_example", label: "境界例" },
      { value: "counterexample", label: "反例" },
      { value: "historical_reference", label: "歴史参考" },
      { value: "critical_reference", label: "批評参考" },
      { value: "user_interpretation", label: "ユーザー解釈" },
    ],
    source?.sourceRole ?? "partial_example",
  );
  const preferenceSelect = createSelectField(
    "好み",
    [
      { value: "positive", label: "好き" },
      { value: "negative", label: "嫌い" },
      { value: "neutral", label: "中立" },
      { value: "not_applicable", label: "該当なし" },
    ],
    source?.preference ?? "neutral",
  );
  const noteInput = createTextareaField("出典メモ", source?.sourceNote ?? "");
  const interpretationInput = createTextareaField("ユーザー解釈", source?.userInterpretation ?? "");
  const contentInput = createTextareaField("原文", content);
  contentInput.className = "source-content-input";

  const btnSave = document.createElement("button");
  btnSave.type = "submit";
  btnSave.textContent = source ? "保存" : "追加";

  form.appendChild(titleInput);
  form.appendChild(authorInput);
  form.appendChild(typeSelect);
  form.appendChild(roleSelect);
  form.appendChild(preferenceSelect);
  form.appendChild(noteInput);
  form.appendChild(interpretationInput);
  form.appendChild(contentInput);
  form.appendChild(btnSave);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    onSave({
      title: getInputValue(titleInput),
      author: getInputValue(authorInput),
      sourceType: getSelectValue(typeSelect) as GenreSource["sourceType"],
      sourceRole: getSelectValue(roleSelect) as GenreSource["sourceRole"],
      preference: getSelectValue(preferenceSelect) as GenreSource["preference"],
      sourceNote: getInputValue(noteInput),
      userInterpretation: getInputValue(interpretationInput),
      content: getInputValue(contentInput),
    });
  });

  container.appendChild(form);
}

function createTextField(label: string, value: string): HTMLElement {
  const el = document.createElement("label");
  el.className = "genre-form-label";
  el.innerHTML = `<span>${label}</span>`;
  const input = document.createElement("input");
  input.className = "genre-form-input";
  input.value = value;
  el.appendChild(input);
  return el;
}

function createTextareaField(label: string, value: string): HTMLElement {
  const el = document.createElement("label");
  el.className = "genre-form-label";
  el.innerHTML = `<span>${label}</span>`;
  const input = document.createElement("textarea");
  input.className = "genre-form-input";
  input.value = value;
  el.appendChild(input);
  return el;
}

function createSelectField(
  label: string,
  options: { value: string; label: string }[],
  selectedValue: string,
): HTMLElement {
  const el = document.createElement("label");
  el.className = "genre-form-label";
  el.innerHTML = `<span>${label}</span>`;
  const select = document.createElement("select");
  select.className = "genre-form-input";
  for (const option of options) {
    const opt = document.createElement("option");
    opt.value = option.value;
    opt.textContent = option.label;
    if (option.value === selectedValue) opt.selected = true;
    select.appendChild(opt);
  }
  el.appendChild(select);
  return el;
}

function getInputValue(labelElement: HTMLElement): string {
  const input = labelElement.querySelector("input, textarea") as HTMLInputElement | HTMLTextAreaElement;
  return input?.value ?? "";
}

function getSelectValue(labelElement: HTMLElement): string {
  const select = labelElement.querySelector("select") as HTMLSelectElement;
  return select?.value ?? "";
}
