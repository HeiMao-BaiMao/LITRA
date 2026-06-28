export interface CollapsibleSidebarOptions {
  minWidth?: number;
  maxWidth?: number;
}

export function setupCollapsibleSidebar(
  sidebarId: string,
  toggleButtonId: string,
  options: CollapsibleSidebarOptions = {},
): void {
  const sidebar = document.getElementById(sidebarId);
  const toggle = document.getElementById(toggleButtonId);
  if (!sidebar || !toggle) return;

  let isOpen = true;
  let isResizing = false;

  toggle.addEventListener("click", () => {
    isOpen = !isOpen;
    sidebar.classList.toggle("open", isOpen);
  });

  const resizer = document.createElement("div");
  resizer.className = "sidebar-resizer";
  sidebar.appendChild(resizer);

  resizer.addEventListener("mousedown", (event) => {
    isResizing = true;
    event.preventDefault();
  });

  window.addEventListener("mousemove", (event) => {
    if (!isResizing) return;
    const width = event.clientX;
    const minWidth = options.minWidth ?? 180;
    const maxWidth = options.maxWidth ?? 400;
    sidebar.style.width = `${Math.max(minWidth, Math.min(maxWidth, width))}px`;
  });

  window.addEventListener("mouseup", () => {
    isResizing = false;
  });
}
