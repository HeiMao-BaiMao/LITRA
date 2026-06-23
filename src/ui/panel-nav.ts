import type { ProjectView } from "../state.ts";

export type PanelNavView = Extract<ProjectView, "characters" | "world" | "relationships" | "memos">;

export interface PanelNavActions {
  onSelectView: (view: PanelNavView) => void;
}

export function renderPanelNav(
  activeView: PanelNavView,
  actions: PanelNavActions,
  container: HTMLElement,
): void {
  container.innerHTML = "";
  container.className = "panel-nav";

  const items: { view: PanelNavView; label: string }[] = [
    { view: "characters", label: "キャラクター" },
    { view: "world", label: "世界観" },
    { view: "relationships", label: "人間関係" },
    { view: "memos", label: "メモ" },
  ];

  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "panel-nav-btn";
    if (item.view === activeView) {
      btn.classList.add("active");
    }
    btn.textContent = item.label;
    btn.addEventListener("click", () => actions.onSelectView(item.view));
    container.appendChild(btn);
  }
}
