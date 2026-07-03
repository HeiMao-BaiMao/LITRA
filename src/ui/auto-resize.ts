export function bindAutoResize(input: HTMLTextAreaElement, maxRows = 15): () => void {
  function updateHeight(): void {
    const style = window.getComputedStyle(input);
    const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2;
    const paddingTop = parseFloat(style.paddingTop);
    const paddingBottom = parseFloat(style.paddingBottom);
    const borderTop = parseFloat(style.borderTopWidth);
    const borderBottom = parseFloat(style.borderBottomWidth);

    const maxHeight = lineHeight * maxRows + paddingTop + paddingBottom + borderTop + borderBottom;

    input.style.height = "auto";
    const scrollHeight = input.scrollHeight;
    const targetHeight = Math.min(scrollHeight, maxHeight);
    input.style.height = `${targetHeight}px`;
    input.style.overflowY = scrollHeight > maxHeight ? "auto" : "hidden";
  }

  function resetHeight(): void {
    input.style.height = "";
    input.style.overflowY = "hidden";
    updateHeight();
  }

  input.addEventListener("input", updateHeight);
  updateHeight();

  return resetHeight;
}
