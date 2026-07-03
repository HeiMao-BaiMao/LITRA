export interface CollapsibleSidebarOptions {
  minWidth?: number;
  maxWidth?: number;
}

export function setupCollapsibleSidebar(
  sidebarId: string,
  toggleButtonId: string,
  _options: CollapsibleSidebarOptions = {},
): void {
  const sidebar = document.getElementById(sidebarId);
  const toggle = document.getElementById(toggleButtonId);
  if (!sidebar || !toggle) return;

  let isOpen = true;

  toggle.addEventListener("click", () => {
    isOpen = !isOpen;
    sidebar.classList.toggle("open", isOpen);
  });
}
