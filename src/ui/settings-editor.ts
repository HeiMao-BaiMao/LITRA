import { getElements } from "./layout.ts";
import { applyStoredRatio, createVerticalResizer } from "./resizable.ts";
import type {
  Character,
  CustomField,
  WorldEntry,
  Episode,
  CharacterRelationshipMap,
} from "../project/schema.ts";

export interface SettingsEditorActions {
  onCreateCharacter: (name: string) => void;
  onUpdateCharacter: (character: Character) => void;
  onDeleteCharacter: (id: string) => void;
  onSelectCharacter: (id: string) => void;
  onCreateWorldEntry: (name: string, category: string) => void;
  onUpdateWorldEntry: (entry: WorldEntry) => void;
  onDeleteWorldEntry: (id: string) => void;
  onSelectWorldEntry: (id: string) => void;
  onUpdateRelationships?: (map: CharacterRelationshipMap) => void;
  onUpdateProjectMemo?: (content: string) => void;
  onPopoutProjectMemo?: () => void;
  projectMemo?: string;
  isProjectMemoDetached?: boolean;
}

let currentCharacter: Character | null = null;
let currentWorldEntry: WorldEntry | null = null;
let updateTimeout: ReturnType<typeof setTimeout> | null = null;
let currentActions: SettingsEditorActions | null = null;

function debounceUpdate(callback: () => void): void {
  if (updateTimeout) {
    clearTimeout(updateTimeout);
  }
  updateTimeout = setTimeout(callback, 400);
}

function callbackUpdate(): void {
  if (currentCharacter && currentActions) {
    currentActions.onUpdateCharacter(currentCharacter);
  } else if (currentWorldEntry && currentActions) {
    currentActions.onUpdateWorldEntry(currentWorldEntry);
  }
}

function createSection(title: string): HTMLElement {
  const section = document.createElement("div");
  section.className = "settings-section";

  const heading = document.createElement("h4");
  heading.className = "settings-section-title";
  heading.textContent = title;
  section.appendChild(heading);

  return section;
}

function createTextField(
  label: string,
  value: string,
  onChange: (value: string) => void,
  multiline = false,
): HTMLElement {
  const row = document.createElement("label");
  row.className = "settings-field";

  const span = document.createElement("span");
  span.textContent = label;
  row.appendChild(span);

  const input = multiline
    ? document.createElement("textarea")
    : document.createElement("input");
  if (!multiline) {
    (input as HTMLInputElement).type = "text";
  }
  input.value = value;
  input.addEventListener("input", () => {
    onChange(input.value);
    debounceUpdate(() => {
      callbackUpdate();
    });
  });
  row.appendChild(input);

  return row;
}

function createCustomFieldRow(
  field: CustomField,
  onChange: () => void,
  onDelete: () => void,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "custom-field-row";

  const labelInput = document.createElement("input");
  labelInput.type = "text";
  labelInput.className = "custom-field-label";
  labelInput.placeholder = "項目名";
  labelInput.value = field.label;
  labelInput.addEventListener("input", () => {
    field.label = labelInput.value;
    onChange();
  });

  const valueInput = document.createElement("textarea");
  valueInput.className = "custom-field-value";
  valueInput.placeholder = "内容";
  valueInput.value = field.value;
  valueInput.addEventListener("input", () => {
    field.value = valueInput.value;
    onChange();
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "custom-field-delete";
  deleteBtn.textContent = "×";
  deleteBtn.title = "削除";
  deleteBtn.addEventListener("click", onDelete);

  row.appendChild(labelInput);
  row.appendChild(valueInput);
  row.appendChild(deleteBtn);
  return row;
}

function renderCustomFieldsSection(
  customFields: CustomField[],
  onUpdate: () => void,
): HTMLElement {
  const section = createSection("カスタム項目");
  const rows = document.createElement("div");
  rows.className = "custom-fields";

  const renderRows = (): void => {
    rows.innerHTML = "";
    customFields.forEach((field, index) => {
      rows.appendChild(
        createCustomFieldRow(
          field,
          () => {
            debounceUpdate(onUpdate);
          },
          () => {
            customFields.splice(index, 1);
            renderRows();
            onUpdate();
          },
        ),
      );
    });
  };

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "custom-field-add";
  addBtn.textContent = "＋ 項目を追加";
  addBtn.addEventListener("click", () => {
    customFields.push({ label: "", value: "" });
    renderRows();
    onUpdate();
  });

  renderRows();
  section.appendChild(rows);
  section.appendChild(addBtn);
  return section;
}

function renderCharacterForm(character: Character): HTMLElement {
  currentCharacter = character;
  currentWorldEntry = null;

  const form = document.createElement("div");
  form.className = "settings-detail-form";

  const basic = createSection("基本情報");
  basic.appendChild(createTextField("名前", character.name, (v) => (character.name = v)));
  basic.appendChild(createTextField("別名・あだ名", character.alias, (v) => (character.alias = v)));
  basic.appendChild(createTextField("役職・役割", character.role, (v) => (character.role = v)));
  basic.appendChild(createTextField("性別", character.gender, (v) => (character.gender = v)));
  basic.appendChild(createTextField("年齢", character.age, (v) => (character.age = v)));
  basic.appendChild(createTextField("誕生日", character.birthday, (v) => (character.birthday = v)));
  basic.appendChild(createTextField("血液型", character.bloodType, (v) => (character.bloodType = v)));
  basic.appendChild(createTextField("身長", character.height, (v) => (character.height = v)));
  basic.appendChild(createTextField("体重", character.weight, (v) => (character.weight = v)));
  form.appendChild(basic);

  const inner = createSection("性格・外見");
  inner.appendChild(createTextField("見た目", character.appearance, (v) => (character.appearance = v), true));
  inner.appendChild(createTextField("性格", character.personality, (v) => (character.personality = v), true));
  inner.appendChild(createTextField("個性", character.individuality, (v) => (character.individuality = v), true));
  form.appendChild(inner);

  const career = createSection("能力・経歴");
  career.appendChild(createTextField("能力・スキル", character.skills, (v) => (character.skills = v), true));
  career.appendChild(createTextField("特技", character.specialSkills, (v) => (character.specialSkills = v), true));
  career.appendChild(createTextField("生い立ち", character.upbringing, (v) => (character.upbringing = v), true));
  career.appendChild(createTextField("背景", character.background, (v) => (character.background = v), true));
  form.appendChild(career);

  const notes = createSection("その他");
  notes.appendChild(createTextField("メモ", character.notes, (v) => (character.notes = v), true));
  form.appendChild(notes);

  form.appendChild(
    renderCustomFieldsSection(character.customFields ?? [], () => {
      debounceUpdate(callbackUpdate);
    }),
  );

  return form;
}

function renderWorldEntryForm(entry: WorldEntry): HTMLElement {
  currentCharacter = null;
  currentWorldEntry = entry;

  const form = document.createElement("div");
  form.className = "settings-detail-form";

  const basic = createSection("基本情報");
  basic.appendChild(createTextField("名前", entry.name, (v) => (entry.name = v)));
  basic.appendChild(createTextField("カテゴリ", entry.category, (v) => (entry.category = v)));
  form.appendChild(basic);

  const nature = createSection("自然・社会");
  nature.appendChild(createTextField("時代", entry.era, (v) => (entry.era = v)));
  nature.appendChild(createTextField("地理・場所", entry.geography, (v) => (entry.geography = v), true));
  nature.appendChild(createTextField("気候", entry.climate, (v) => (entry.climate = v)));
  nature.appendChild(createTextField("人口", entry.population, (v) => (entry.population = v)));
  form.appendChild(nature);

  const system = createSection("制度・勢力");
  system.appendChild(createTextField("政治", entry.politics, (v) => (entry.politics = v), true));
  system.appendChild(createTextField("法律", entry.laws, (v) => (entry.laws = v), true));
  system.appendChild(createTextField("経済", entry.economy, (v) => (entry.economy = v), true));
  system.appendChild(createTextField("軍事", entry.military, (v) => (entry.military = v), true));
  system.appendChild(createTextField("宗教", entry.religion, (v) => (entry.religion = v), true));
  system.appendChild(createTextField("言語", entry.language, (v) => (entry.language = v), true));
  form.appendChild(system);

  const culture = createSection("文化・歴史");
  culture.appendChild(createTextField("文化", entry.culture, (v) => (entry.culture = v), true));
  culture.appendChild(createTextField("歴史", entry.history, (v) => (entry.history = v), true));
  culture.appendChild(createTextField("技術・魔術体系", entry.technology, (v) => (entry.technology = v), true));
  form.appendChild(culture);

  const notes = createSection("その他");
  notes.appendChild(createTextField("メモ", entry.notes, (v) => (entry.notes = v), true));
  form.appendChild(notes);

  form.appendChild(
    renderCustomFieldsSection(entry.customFields ?? [], () => {
      debounceUpdate(callbackUpdate);
    }),
  );

  return form;
}

function createCharacterSelect(
  characters: Character[],
  value: string,
  onChange: (id: string) => void,
): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "relationship-character-select";

  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "選択...";
  select.appendChild(empty);

  for (const character of characters) {
    const option = document.createElement("option");
    option.value = character.id;
    option.textContent = character.name || "（無題）";
    select.appendChild(option);
  }

  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

function createDirectionSelect(
  value: "a-to-b" | "b-to-a" | "mutual",
  onChange: (direction: "a-to-b" | "b-to-a" | "mutual") => void,
): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "relationship-direction-select";

  const options: { value: "a-to-b" | "b-to-a" | "mutual"; label: string }[] = [
    { value: "a-to-b", label: "A → B" },
    { value: "b-to-a", label: "A ← B" },
    { value: "mutual", label: "A ↔ B" },
  ];

  for (const option of options) {
    const el = document.createElement("option");
    el.value = option.value;
    el.textContent = option.label;
    select.appendChild(el);
  }

  select.value = value;
  select.addEventListener("change", () => onChange(select.value as "a-to-b" | "b-to-a" | "mutual"));
  return select;
}

function renderRelationshipRow(
  relationship: import("../project/schema.ts").CharacterRelationship,
  characters: Character[],
  onChange: () => void,
  onDelete: () => void,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "relationship-row";

  const labelA = document.createElement("span");
  labelA.className = "relationship-label";
  labelA.textContent = "A";

  const labelB = document.createElement("span");
  labelB.className = "relationship-label";
  labelB.textContent = "B";

  const selectA = createCharacterSelect(characters, relationship.characterAId, (id) => {
    relationship.characterAId = id;
    onChange();
  });

  const selectB = createCharacterSelect(characters, relationship.characterBId, (id) => {
    relationship.characterBId = id;
    onChange();
  });

  const directionSelect = createDirectionSelect(relationship.direction, (direction) => {
    relationship.direction = direction;
    onChange();
  });

  const description = document.createElement("input");
  description.type = "text";
  description.className = "relationship-description";
  description.placeholder = "関係の説明（例：敵同士で憎み合っている）";
  description.value = relationship.description;
  description.addEventListener("input", () => {
    relationship.description = description.value;
    onChange();
  });

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "relationship-delete";
  deleteBtn.textContent = "×";
  deleteBtn.title = "削除";
  deleteBtn.addEventListener("click", onDelete);

  row.appendChild(labelA);
  row.appendChild(selectA);
  row.appendChild(directionSelect);
  row.appendChild(labelB);
  row.appendChild(selectB);
  row.appendChild(description);
  row.appendChild(deleteBtn);
  return row;
}

function renderRelationshipEditor(
  episodes: Episode[],
  characters: Character[],
  map: CharacterRelationshipMap,
  onUpdate: () => void,
): HTMLElement {
  const container = document.createElement("div");
  container.className = "relationship-editor";

  const header = document.createElement("div");
  header.className = "relationship-editor-header";

  const title = document.createElement("h3");
  title.textContent = "人間関係";
  header.appendChild(title);

  const episodeSelect = document.createElement("select");
  episodeSelect.className = "relationship-episode-select";

  const globalOption = document.createElement("option");
  globalOption.value = "";
  globalOption.textContent = "全体（全話共通）";
  episodeSelect.appendChild(globalOption);

  const sortedEpisodes = [...episodes].sort((a, b) => a.order - b.order);
  for (const episode of sortedEpisodes) {
    const option = document.createElement("option");
    option.value = episode.id;
    option.textContent = episode.title || "（無題）";
    episodeSelect.appendChild(option);
  }

  header.appendChild(episodeSelect);
  container.appendChild(header);

  const rowsContainer = document.createElement("div");
  rowsContainer.className = "relationship-rows";
  container.appendChild(rowsContainer);

  const renderRows = (): void => {
    rowsContainer.innerHTML = "";
    const group = map.groups.find((g) => g.episodeId === episodeSelect.value);
    if (!group) return;

    for (let i = 0; i < group.relationships.length; i++) {
      const relationship = group.relationships[i];
      rowsContainer.appendChild(
        renderRelationshipRow(
          relationship,
          characters,
          () => {
            onUpdate();
          },
          () => {
            group.relationships.splice(i, 1);
            if (group.relationships.length === 0) {
              map.groups = map.groups.filter((g) => g.episodeId !== group.episodeId);
            }
            renderRows();
            onUpdate();
          },
        ),
      );
    }
  };

  episodeSelect.addEventListener("change", renderRows);

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "relationship-add-button";
  addBtn.textContent = "＋ 関係を追加";
  addBtn.addEventListener("click", () => {
    const group = map.groups.find((g) => g.episodeId === episodeSelect.value);
    const targetGroup = group ?? { episodeId: episodeSelect.value, relationships: [] };
    if (!group) {
      map.groups.push(targetGroup);
    }
    targetGroup.relationships.push({
      id: crypto.randomUUID(),
      characterAId: "",
      characterBId: "",
      direction: "mutual",
      description: "",
    });
    renderRows();
    onUpdate();
  });

  container.appendChild(addBtn);

  renderRows();
  return container;
}

function renderList<T extends { id: string; name: string }>(
  items: T[],
  currentId: string | null,
  onSelect: (id: string) => void,
  onDelete: (id: string) => void,
): HTMLElement {
  const list = document.createElement("div");
  list.className = "settings-list";

  for (const item of items) {
    const row = document.createElement("div");
    row.className = "settings-list-item";
    if (item.id === currentId) {
      row.classList.add("active");
    }

    const nameBtn = document.createElement("button");
    nameBtn.type = "button";
    nameBtn.className = "settings-list-name";
    nameBtn.textContent = item.name || "（無題）";
    nameBtn.addEventListener("click", () => onSelect(item.id));

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "settings-list-delete";
    deleteBtn.textContent = "×";
    deleteBtn.title = "削除";
    deleteBtn.addEventListener("click", () => {
      if (window.confirm(`「${item.name || "（無題）"}」を削除しますか？`)) {
        onDelete(item.id);
      }
    });

    row.appendChild(nameBtn);
    row.appendChild(deleteBtn);
    list.appendChild(row);
  }

  return list;
}

function createAddButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "settings-add-button";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

function renderProjectMemoEditor(
  content: string,
  onUpdate: (content: string) => void,
  onPopout: (() => void) | undefined,
  isDetached: boolean,
): HTMLElement {
  currentCharacter = null;
  currentWorldEntry = null;

  const container = document.createElement("div");
  container.className = "project-memo-editor";

  const header = document.createElement("div");
  header.className = "project-memo-header";

  const title = document.createElement("h3");
  title.textContent = "作品メモ";
  header.appendChild(title);

  if (onPopout) {
    const popoutBtn = document.createElement("button");
    popoutBtn.type = "button";
    popoutBtn.className = "btn-popout";
    popoutBtn.title = "別ウィンドウで開く";
    popoutBtn.textContent = "↗";
    popoutBtn.addEventListener("click", onPopout);
    header.appendChild(popoutBtn);
  }

  container.appendChild(header);

  if (isDetached) {
    const notice = document.createElement("div");
    notice.className = "project-memo-detached-notice";
    notice.textContent = "別ウィンドウで表示中です。";
    container.appendChild(notice);
    return container;
  }

  const textarea = document.createElement("textarea");
  textarea.className = "project-memo-textarea";
  textarea.placeholder = "作品全体に関するメモを自由に書いてください...";
  textarea.value = content;
  textarea.spellcheck = false;
  textarea.addEventListener("input", () => {
    debounceUpdate(() => onUpdate(textarea.value));
  });

  container.appendChild(textarea);
  return container;
}

export async function renderSettingsEditor(
  view: "characters" | "world" | "relationships" | "projectMemo",
  characters: Character[],
  worldEntries: WorldEntry[],
  episodes: Episode[],
  relationshipsMap: CharacterRelationshipMap,
  currentCharacterId: string | null,
  currentWorldEntryId: string | null,
  actions: SettingsEditorActions,
  container?: HTMLElement,
): Promise<void> {
  currentActions = actions;
  const panel = container ?? getElements().settingsPanel;

  await applyStoredRatio(panel, "--settings-sidebar-width", "settingsSidebar", 0.25);

  panel.innerHTML = "";

  const wrapper = document.createElement("div");
  wrapper.className = "settings-editor";
  wrapper.style.setProperty(
    "--settings-sidebar-width",
    panel.style.getPropertyValue("--settings-sidebar-width"),
  );

  const sidebar = document.createElement("div");
  sidebar.className = "settings-editor-sidebar";

  const detail = document.createElement("div");
  detail.className = "settings-editor-detail";

  if (view === "characters") {
    sidebar.appendChild(
      createAddButton("＋ 新しいキャラクター", () => {
        const name = window.prompt("キャラクター名を入力してください");
        if (name) actions.onCreateCharacter(name);
      }),
    );
    sidebar.appendChild(
      renderList(
        characters,
        currentCharacterId,
        actions.onSelectCharacter,
        actions.onDeleteCharacter,
      ),
    );

    const selected = characters.find((c) => c.id === currentCharacterId);
    if (selected) {
      detail.appendChild(renderCharacterForm(selected));
    } else {
      detail.innerHTML = '<div class="settings-empty">キャラクターを選択または作成してください</div>';
    }
  } else if (view === "world") {
    sidebar.appendChild(
      createAddButton("＋ 新しい世界観", () => {
        const name = window.prompt("世界観の名前を入力してください");
        if (name) {
          const category = window.prompt("カテゴリ（場所・時代・制度 など）") || "";
          actions.onCreateWorldEntry(name, category);
        }
      }),
    );
    sidebar.appendChild(
      renderList(
        worldEntries,
        currentWorldEntryId,
        actions.onSelectWorldEntry,
        actions.onDeleteWorldEntry,
      ),
    );

    const selected = worldEntries.find((e) => e.id === currentWorldEntryId);
    if (selected) {
      detail.appendChild(renderWorldEntryForm(selected));
    } else {
      detail.innerHTML = '<div class="settings-empty">世界観を選択または作成してください</div>';
    }
  } else if (view === "relationships") {
    sidebar.classList.add("hidden");
    detail.classList.add("relationships-detail");
    detail.appendChild(
      renderRelationshipEditor(episodes, characters, relationshipsMap, () => {
        debounceUpdate(() => {
          if (actions.onUpdateRelationships) {
            actions.onUpdateRelationships(relationshipsMap);
          }
        });
      }),
    );
  } else {
    sidebar.classList.add("hidden");
    detail.classList.add("project-memo-detail");
    detail.appendChild(
      renderProjectMemoEditor(
        actions.projectMemo ?? "",
        (content) => {
          debounceUpdate(() => {
            if (actions.onUpdateProjectMemo) {
              actions.onUpdateProjectMemo(content);
            }
          });
        },
        actions.onPopoutProjectMemo,
        actions.isProjectMemoDetached ?? false,
      ),
    );
  }

  wrapper.appendChild(sidebar);
  wrapper.appendChild(detail);
  panel.appendChild(wrapper);

  if (view !== "relationships" && view !== "projectMemo") {
    createVerticalResizer({
      container: wrapper,
      propertyName: "--settings-sidebar-width",
      position: "inside",
      saveKey: "settingsSidebar",
    });
  }
}
