import { emit, listen } from "@tauri-apps/api/event";
import { renderSettingsEditor, type SettingsEditorActions } from "./ui/settings-editor.ts";
import type { Character, WorldEntry, Episode, CharacterRelationshipMap } from "./project/schema.ts";

interface SettingsSyncPayload {
  view: "characters" | "world" | "relationships" | "projectMemo";
  characters: Character[];
  worldEntries: WorldEntry[];
  episodes: Episode[];
  relationshipsMap: CharacterRelationshipMap;
  currentCharacterId: string | null;
  currentWorldEntryId: string | null;
  projectMemo?: string;
  isProjectMemoDetached?: boolean;
}

function init(): void {
  const container = document.querySelector<HTMLElement>("#settings-container");
  const tabCharacters = document.querySelector<HTMLButtonElement>("#tab-characters");
  const tabWorld = document.querySelector<HTMLButtonElement>("#tab-world");
  const tabRelationships = document.querySelector<HTMLButtonElement>("#tab-relationships");
  const tabProjectMemo = document.querySelector<HTMLButtonElement>("#tab-project-memo");
  if (!container || !tabCharacters || !tabWorld || !tabRelationships || !tabProjectMemo) return;

  const actions: SettingsEditorActions = {
    onCreateCharacter: (name) => emit("settings-create-character", { name }),
    onUpdateCharacter: (character) => emit("settings-update-character", { character }),
    onDeleteCharacter: (id) => emit("settings-delete-character", { id }),
    onSelectCharacter: (id) => emit("settings-select-character", { id }),
    onCreateWorldEntry: (name, category) => emit("settings-create-world", { name, category }),
    onUpdateWorldEntry: (entry) => emit("settings-update-world", { entry }),
    onDeleteWorldEntry: (id) => emit("settings-delete-world", { id }),
    onSelectWorldEntry: (id) => emit("settings-select-world", { id }),
    onUpdateRelationships: (map) => emit("settings-update-relationships", { map }),
    onUpdateProjectMemo: (content) => emit("settings-update-project-memo", { content }),
    onPopoutProjectMemo: () => emit("settings-popout-project-memo", {}),
  };

  listen<SettingsSyncPayload>("settings-sync", (event) => {
    const {
      view,
      characters,
      worldEntries,
      episodes,
      relationshipsMap,
      currentCharacterId,
      currentWorldEntryId,
      projectMemo,
      isProjectMemoDetached,
    } = event.payload;
    tabCharacters.classList.toggle("active", view === "characters");
    tabWorld.classList.toggle("active", view === "world");
    tabRelationships.classList.toggle("active", view === "relationships");
    tabProjectMemo.classList.toggle("active", view === "projectMemo");
    actions.projectMemo = projectMemo;
    actions.isProjectMemoDetached = isProjectMemoDetached;
    renderSettingsEditor(
      view,
      characters,
      worldEntries,
      episodes,
      relationshipsMap,
      currentCharacterId,
      currentWorldEntryId,
      actions,
      container,
    );
  });

  tabCharacters.addEventListener("click", () => emit("settings-select-view", { view: "characters" }));
  tabWorld.addEventListener("click", () => emit("settings-select-view", { view: "world" }));
  tabRelationships.addEventListener("click", () => emit("settings-select-view", { view: "relationships" }));
  tabProjectMemo.addEventListener("click", () => emit("settings-select-view", { view: "projectMemo" }));

  emit("settings-ready", {});
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
