import { getElements } from "./layout.ts";

export interface ToolbarActions {
  onContinue: () => void;
  onRewrite: () => void;
  onFeedback: () => void;
  onOpenSettings: () => void;
  onOpenProjects: () => void;
}

export function bindToolbarActions(actions: ToolbarActions): void {
  const {
    btnContinue,
    btnRewrite,
    btnFeedback,
    btnSettings,
    btnProjects,
  } = getElements();

  btnContinue.addEventListener("click", actions.onContinue);
  btnRewrite.addEventListener("click", actions.onRewrite);
  btnFeedback.addEventListener("click", actions.onFeedback);
  btnSettings.addEventListener("click", actions.onOpenSettings);
  btnProjects.addEventListener("click", actions.onOpenProjects);
}
