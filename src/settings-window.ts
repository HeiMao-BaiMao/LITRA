import { emit, listen } from "@tauri-apps/api/event";
import { renderSettingsEditor, type SettingsEditorActions } from "./ui/settings-editor.ts";
import type { Character, WorldEntry } from "./project/schema.ts";

interface SettingsSyncPayload {
  view: "characters" | "world";
  characters: Character[];
  worldEntries: WorldEntry[];
  currentCharacterId: string | null;
  currentWorldEntryId: string | null;
}

function init(): void {
  const container = document.querySelector<HTMLElement>("#settings-container");
  const tabCharacters = document.querySelector<HTMLButtonElement>("#tab-characters");
  const tabWorld = document.querySelector<HTMLButtonElement>("#tab-world");
  if (!container || !tabCharacters || !tabWorld) return;

  const actions: SettingsEditorActions = {
    onCreateCharacter: (name) => emit("settings-create-character", { name }),
    onUpdateCharacter: (character) => emit("settings-update-character", { character }),
    onDeleteCharacter: (id) => emit("settings-delete-character", { id }),
    onSelectCharacter: (id) => emit("settings-select-character", { id }),
    onCreateWorldEntry: (name, category) => emit("settings-create-world", { name, category }),
    onUpdateWorldEntry: (entry) => emit("settings-update-world", { entry }),
    onDeleteWorldEntry: (id) => emit("settings-delete-world", { id }),
    onSelectWorldEntry: (id) => emit("settings-select-world", { id }),
  };

  listen<SettingsSyncPayload>("settings-sync", (event) => {
    const { view, characters, worldEntries, currentCharacterId, currentWorldEntryId } = event.payload;
    tabCharacters.classList.toggle("active", view === "characters");
    tabWorld.classList.toggle("active", view === "world");
    renderSettingsEditor(
      view,
      characters,
      worldEntries,
      currentCharacterId,
      currentWorldEntryId,
      actions,
      container,
    );
  });

  tabCharacters.addEventListener("click", () => emit("settings-select-view", { view: "characters" }));
  tabWorld.addEventListener("click", () => emit("settings-select-view", { view: "world" }));

  emit("settings-ready", {});
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
