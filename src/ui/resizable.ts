import { loadPanelRatio, savePanelRatio, type PanelRatioKey } from "../layout-store.ts";

export type ResizerPosition = "left" | "right" | "inside";

export interface ResizerOptions {
  container: HTMLElement;
  propertyName: string;
  position: ResizerPosition;
  saveKey: PanelRatioKey;
  minRatio?: number;
  maxRatio?: number;
  disabled?: () => boolean;
}

function parseRatio(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseFloat(value.replace("%", ""));
  return Number.isNaN(parsed) ? 0 : parsed / 100;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export async function applyStoredRatio(
  container: HTMLElement,
  propertyName: string,
  saveKey: PanelRatioKey,
  fallbackRatio: number,
): Promise<void> {
  const stored = await loadPanelRatio(saveKey);
  const ratio = stored ?? fallbackRatio;
  container.style.setProperty(propertyName, `${(ratio * 100).toFixed(2)}%`);
}

export function createVerticalResizer(options: ResizerOptions): HTMLElement {
  const { container, propertyName, position, saveKey } = options;
  const minRatio = options.minRatio ?? 0.1;
  const maxRatio = options.maxRatio ?? 0.5;

  const resizer = document.createElement("div");
  resizer.className = `resizer resizer-vertical resizer-${position}`;
  resizer.setAttribute("role", "separator");
  resizer.setAttribute("aria-orientation", "vertical");
  resizer.setAttribute("aria-label", "パネル幅を調整");

  const line = document.createElement("div");
  line.className = "resizer-line";
  resizer.appendChild(line);

  container.appendChild(resizer);

  let startX = 0;
  let startRatio = 0;
  let originalUserSelect = "";

  const updateDisabled = (): void => {
    const isDisabled = options.disabled?.() ?? false;
    resizer.classList.toggle("resizer-disabled", isDisabled);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    if (options.disabled?.()) return;

    event.preventDefault();
    startX = event.clientX;
    startRatio = parseRatio(container.style.getPropertyValue(propertyName));
    if (startRatio === 0) {
      const computed = getComputedStyle(container).getPropertyValue(propertyName);
      startRatio = parseRatio(computed);
    }

    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add("resizer-dragging");
    originalUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!resizer.classList.contains("resizer-dragging")) return;

    const deltaX = event.clientX - startX;
    const deltaRatio = deltaX / container.clientWidth;

    let newRatio: number;
    if (position === "right") {
      newRatio = startRatio - deltaRatio;
    } else {
      newRatio = startRatio + deltaRatio;
    }

    newRatio = clamp(newRatio, minRatio, maxRatio);
    container.style.setProperty(propertyName, `${(newRatio * 100).toFixed(2)}%`);
  };

  const onPointerUp = async (event: PointerEvent): Promise<void> => {
    if (!resizer.classList.contains("resizer-dragging")) return;

    resizer.releasePointerCapture(event.pointerId);
    resizer.classList.remove("resizer-dragging");
    document.body.style.userSelect = originalUserSelect;

    const currentRatio = parseRatio(container.style.getPropertyValue(propertyName));
    await savePanelRatio(saveKey, currentRatio);
  };

  resizer.addEventListener("pointerdown", onPointerDown);
  resizer.addEventListener("pointermove", onPointerMove);
  resizer.addEventListener("pointerup", onPointerUp);
  resizer.addEventListener("pointercancel", onPointerUp);

  updateDisabled();

  return resizer;
}
