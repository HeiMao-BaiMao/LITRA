import { emit, listen } from "@tauri-apps/api/event";
import { renderSettingsEditor, type SettingsEditorActions } from "./ui/settings-editor.ts";
import { renderMemosEditor, type MemosEditorActions } from "./ui/memos-editor.ts";
import { renderPanelNav, type PanelNavView, type PanelNavActions } from "./ui/panel-nav.ts";
import type { Character, WorldEntry, Episode, CharacterRelationshipMap } from "./project/schema.ts";
import type { ProjectMemo } from "./project/project-memo.ts";

interface ProjectPanelSyncPayload {
  view: PanelNavView;
  characters: Character[];
  worldEntries: WorldEntry[];
  episodes: Episode[];
  relationshipsMap: CharacterRelationshipMap;
  currentCharacterId: string | null;
  currentWorldEntryId: string | null;
  projectMemos: ProjectMemo[];
  currentMemoId: string | null;
}

const navContainer = document.querySelector<HTMLElement>("#panel-nav");
const contentContainer = document.querySelector<HTMLElement>("#panel-content");
if (!navContainer || !contentContainer) {
  console.error("[phenex:project-panel-window] containers not found");
  throw new Error("#panel-nav or #panel-content not found");
}

const settingsActions: SettingsEditorActions = {
  onCreateCharacter: (name) => emit("settings-create-character", { name }),
  onUpdateCharacter: (character) => emit("settings-update-character", { character }),
  onDeleteCharacter: (id) => emit("settings-delete-character", { id }),
  onSelectCharacter: (id) => emit("settings-select-character", { id }),
  onCreateWorldEntry: (name, category) => emit("settings-create-world", { name, category }),
  onUpdateWorldEntry: (entry) => emit("settings-update-world", { entry }),
  onDeleteWorldEntry: (id) => emit("settings-delete-world", { id }),
  onSelectWorldEntry: (id) => emit("settings-select-world", { id }),
  onUpdateRelationships: (map) => emit("settings-update-relationships", { map }),
};

const memosActions: MemosEditorActions = {
  onCreate: (title) => emit("project-memos-create", { title }),
  onUpdate: (id, updates) => emit("project-memos-update", { id, ...updates }),
  onDelete: (id) => emit("project-memos-delete", { id }),
  onSelect: (id) => emit("project-memos-select", { id }),
};

const panelNavActions: PanelNavActions = {
  onSelectView: (view) => emit("project-panel-select-view", { view }),
};

function isSettingsView(view: PanelNavView): view is "characters" | "world" | "relationships" {
  return view === "characters" || view === "world" || view === "relationships";
}

function render(payload: ProjectPanelSyncPayload): void {
  renderPanelNav(payload.view, panelNavActions, navContainer!);

  if (isSettingsView(payload.view)) {
    renderSettingsEditor(
      payload.view,
      payload.characters,
      payload.worldEntries,
      payload.episodes,
      payload.relationshipsMap,
      payload.currentCharacterId,
      payload.currentWorldEntryId,
      settingsActions,
      contentContainer!,
    );
  } else {
    renderMemosEditor(
      payload.projectMemos,
      payload.currentMemoId,
      memosActions,
      contentContainer!,
    );
  }
}

listen<ProjectPanelSyncPayload>("project-panel-sync", (event) => {
  render(event.payload);
});

emit("project-panel-ready", {});
