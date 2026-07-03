export function showError(message: string, error?: unknown): void {
  console.error("[phenex:error]", message, error);
  window.alert(`エラー: ${message}${error ? `\n${error instanceof Error ? error.message : String(error)}` : ""}`);
}

export function showInfo(message: string): void {
  console.info("[phenex:info]", message);
}

export function registerSpinner(elementId: string, active: boolean): void {
  const el = document.getElementById(elementId);
  el?.classList.toggle("hidden", !active);
}
