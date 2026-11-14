const composing = new WeakSet();
const deferred = new Map();

export function escapeHTML(value = '') {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
}

function selection(control) {
  return typeof control.selectionStart === 'number'
    ? { start: control.selectionStart, end: control.selectionEnd, direction: control.selectionDirection }
    : null;
}

export function renderView(root, markup) {
  const active = document.activeElement;
  if (active && root.contains(active) && composing.has(active)) {
    deferred.set(root, markup);
    return false;
  }
  const controls = [...root.querySelectorAll('[data-focus-key]')].filter(control => 'value' in control).map(control => ({
    key: control.dataset.focusKey, value: control.value, focused: control === active,
    dirty: control.dataset.reviewDirty === 'true', selection: selection(control), scrollTop: control.scrollTop,
    preserveValue: control === active || control.dataset.reviewDirty === 'true',
  }));
  const scrolls = [...root.querySelectorAll('[data-scroll-key]')].map(element => ({ key: element.dataset.scrollKey, top: element.scrollTop, left: element.scrollLeft }));
  const dialogs = [...root.querySelectorAll('dialog[open][id]')].map(element => element.id);
  const top = root.scrollTop;
  const left = root.scrollLeft;
  root.innerHTML = markup;
  for (const saved of controls) {
    const control = [...root.querySelectorAll('[data-focus-key]')].find(element => element.dataset.focusKey === saved.key);
    if (!control || !('value' in control)) continue;
    const acknowledged = control.value === saved.value;
    if (saved.preserveValue && !acknowledged) control.value = saved.value;
    if (saved.dirty && !acknowledged) control.dataset.reviewDirty = 'true';
    if (saved.focused) control.focus({ preventScroll: true });
    if (saved.selection && typeof control.setSelectionRange === 'function') {
      control.setSelectionRange(Math.min(saved.selection.start, control.value.length), Math.min(saved.selection.end, control.value.length), saved.selection.direction);
    }
    control.scrollTop = saved.scrollTop;
  }
  for (const saved of scrolls) {
    const element = [...root.querySelectorAll('[data-scroll-key]')].find(item => item.dataset.scrollKey === saved.key);
    if (element) { element.scrollTop = saved.top; element.scrollLeft = saved.left; }
  }
  for (const id of dialogs) {
    const dialog = [...root.querySelectorAll('dialog[id]')].find(element => element.id === id);
    if (dialog && !dialog.open) dialog.showModal();
  }
  root.scrollTop = top;
  root.scrollLeft = left;
  return true;
}

export function showError(root, error) {
  let feedback = root.querySelector('[data-feedback]');
  if (!feedback) {
    feedback = document.createElement('p');
    feedback.dataset.feedback = '';
    root.prepend(feedback);
  }
  feedback.classList.add('design-warning');
  feedback.setAttribute('role', 'alert');
  feedback.textContent = error?.message || String(error);
}

document.addEventListener('input', event => {
  if (event.target.matches?.('[data-focus-key]')) event.target.dataset.reviewDirty = 'true';
}, true);
document.addEventListener('compositionstart', event => composing.add(event.target), true);
document.addEventListener('compositionend', event => {
  composing.delete(event.target);
  queueMicrotask(() => {
    for (const [root, markup] of deferred) {
      if (root.contains(event.target) || !root.isConnected) {
        deferred.delete(root);
        if (root.isConnected) renderView(root, markup);
      }
    }
  });
}, true);
