import { client } from './design-client.js';
import { DesignWindows } from './design-windows.js';
import { mountReferences, mountProjectMemos } from './references.js';
import { mountGenreLibrary, mountGenreChat } from './genres.js';
import { escapeHTML as esc, renderView, showError } from './view-utils.js';

const surface = client.descriptor.surface;
const referenceTabs = ['characters', 'world', 'relationships'];
const mainViews = ['editor', ...referenceTabs, 'project-memos'];
const labels = { chat: '作品チャット', summary: 'エピソード要約', memo: 'エピソードメモ', settings: '作品設定資料', 'project-memos': 'プロジェクトメモ', 'genre-chat': 'ジャンル専用チャット', 'genre-library': 'ジャンルライブラリ' };
let mainView = new URL(location.href).searchParams.get('view') || 'editor';
if (!mainViews.includes(mainView)) mainView = 'editor';
let renderedState = null;
let mountedKind = null;
let disposeComponent = null;
let panelBuilt = false;
let renderQueue = Promise.resolve();
let initializationError = null;
const drafts = new Map();
const composing = new WeakSet();
const focusByScope = new Map();
let draftTimer;
let draftFlight = null;
let geometryTimer;

function project(state = client.state) { return state?.projects.find(item => item.id === state.activeProjectId) || null; }
function episode(state = client.state) { return project(state)?.episodes.find(item => item.id === state.activeEpisodeId) || null; }

function report(message, error = false) {
  const text = message?.message || String(message);
  const status = document.querySelector('[data-design-status]');
  if (status) status.textContent = text;
  for (const node of document.querySelectorAll('[data-design-connection]')) { node.textContent = text; node.classList.toggle('design-warning', error); }
  if (error) {
    let feedback = document.querySelector('[data-global-feedback]');
    if (!feedback) {
      feedback = document.createElement('p'); feedback.dataset.globalFeedback = ''; feedback.className = 'design-global-feedback'; feedback.setAttribute('role', 'alert'); document.body.append(feedback);
    }
    feedback.textContent = text;
  }
}
const reportError = error => report(error, true);

function scopeKey(type, state = renderedState || client.state) {
  if (!state) return null;
  const owner = project(state);
  const selected = owner?.selection;
  if (type === 'settings') return `settings:${owner?.id}:${selected?.settingsTab}:${selected?.characterId}:${selected?.worldId}:${selected?.relationshipEpisodeId}`;
  if (type === 'project-memos') return `project-memos:${owner?.id}:${selected?.projectMemoId}`;
  if (type === 'chat') return `chat:${owner?.id}`;
  if (type === 'genre-chat') {
    const genreId = client.descriptor.genreId || state.activeGenreId;
    const genre = state.genres.find(item => item.id === genreId);
    return `genre-chat:${genreId}:${genre?.chat.activeThreadId}`;
  }
  if (type === 'genre-library') {
    const genre = state.genres.find(item => item.id === state.activeGenreId);
    return `genre-library:${genre?.id}:${genre?.selection.tab}:${genre?.selection.sourceId}`;
  }
  return `${type}:${owner?.id}:${state.activeEpisodeId}`;
}

function scopeRoot(type) {
  return [...document.querySelectorAll('[data-panel-scope]')].find(node => node.dataset.panelScope === type) || null;
}

function captureView(type, state = renderedState || client.state) {
  const root = scopeRoot(type);
  const key = scopeKey(type, state);
  if (!root || !key) return null;
  return { key, value: {
    focusKey: focusByScope.get(key) || null,
    top: root.scrollTop, left: root.scrollLeft,
    controls: [...root.querySelectorAll('[data-focus-key]')].filter(node => typeof node.selectionStart === 'number').map(node => ({ key: node.dataset.focusKey, start: node.selectionStart, end: node.selectionEnd, top: node.scrollTop })),
    scrolls: [...root.querySelectorAll('[data-scroll-key]')].map(node => ({ key: node.dataset.scrollKey, top: node.scrollTop, left: node.scrollLeft })),
  } };
}

async function saveView(type, state) {
  const saved = captureView(type, state);
  if (saved) await client.saveViewState(saved.key, saved.value);
}

function restoreView(type, focus = false) {
  const root = scopeRoot(type);
  const saved = client.loadViewState(scopeKey(type));
  if (!root || !saved) return;
  root.scrollTop = saved.top || 0; root.scrollLeft = saved.left || 0;
  for (const position of saved.controls || []) {
    const node = [...root.querySelectorAll('[data-focus-key]')].find(item => item.dataset.focusKey === position.key);
    if (!node || typeof node.setSelectionRange !== 'function') continue;
    node.setSelectionRange(Math.min(position.start, node.value.length), Math.min(position.end, node.value.length));
    node.scrollTop = position.top;
    if (focus && saved.focusKey === position.key) node.focus({ preventScroll: true });
  }
  for (const position of saved.scrolls || []) {
    const node = [...root.querySelectorAll('[data-scroll-key]')].find(item => item.dataset.scrollKey === position.key);
    if (node) { node.scrollTop = position.top; node.scrollLeft = position.left; }
  }
}

const windows = new DesignWindows(client, { saveView, onChange: () => scheduleRender(), onError: reportError });
client.windowDriver = windows;
client.mainDriver = view => surface === 'main' ? navigateMain(view) : windows.openMain(view);

function scalarBinding(field, state) {
  const owner = project(state);
  const current = episode(state);
  if (field.hasAttribute('data-document-field')) {
    if (!owner || !current) return null;
    const name = field.dataset.documentField;
    return { key: `episode:${owner.id}:${current.id}:${name}`, value: current[name] || '', command: 'episode.update', payload: { projectId: owner.id, episodeId: current.id, changes: {} }, name };
  }
  if (field.hasAttribute('data-project-chat')) {
    if (!owner) return null;
    return { key: `chat:${owner.id}:input`, value: owner.chat.input, command: 'chat.update', payload: { projectId: owner.id, changes: {} }, name: 'input' };
  }
  if (field.hasAttribute('data-direct-writing')) {
    if (!owner) return null;
    return { key: `chat:${owner.id}:directWriting`, value: !!owner.chat.directWriting, command: 'chat.update', payload: { projectId: owner.id, changes: {} }, name: 'directWriting', checkbox: true };
  }
  if (field.hasAttribute('data-role-field')) {
    const role = field.dataset.roleName;
    const name = field.dataset.roleField;
    return { key: `role:${role}:${name}`, value: state.settings.roles[role][name], command: 'settings.update', payload: {}, role, name };
  }
  return null;
}

function syncScalars(state) {
  for (const field of document.querySelectorAll('[data-document-field],[data-project-chat],[data-direct-writing],[data-role-field]')) {
    if (composing.has(field)) continue;
    const binding = scalarBinding(field, state);
    const changed = binding?.key !== field._designBinding?.key;
    field._designBinding = binding;
    field.disabled = !binding;
    if (!binding) { if ('value' in field) field.value = ''; continue; }
    field.dataset.focusKey = binding.key;
    if (!drafts.has(binding.key) && (changed || document.activeElement !== field)) {
      if (binding.checkbox) field.checked = binding.value;
      else if (field.value !== binding.value) field.value = binding.value;
      delete field.dataset.reviewDirty;
    }
  }
}

function queueDraft(field) {
  const binding = field._designBinding;
  if (!binding) return;
  const value = binding.checkbox ? field.checked : field.value;
  const payload = binding.role ? { roles: { [binding.role]: { [binding.name]: value } } } : { ...binding.payload, changes: { [binding.name]: value } };
  drafts.set(binding.key, { command: binding.command, payload, value });
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => flushDrafts().catch(reportError), 350);
  report('画面案データをブラウザに保存中…');
}

async function flushDrafts() {
  clearTimeout(draftTimer);
  if (draftFlight) { await draftFlight; if (drafts.size) await flushDrafts(); return; }
  if (!drafts.size) return;
  draftFlight = (async () => {
    while (drafts.size) {
      const [key, entry] = drafts.entries().next().value;
      await client.dispatch(entry.command, entry.payload);
      if (drafts.get(key) === entry) drafts.delete(key);
    }
  })();
  try { await draftFlight; report('ブラウザ保存済み・画面案専用'); }
  finally { draftFlight = null; }
}
client.addFlusher(flushDrafts, () => drafts.size > 0);

function syncPickers(state) {
  const owner = project(state);
  const projectsMarkup = state.projects.map(item => `<option value="${esc(item.id)}">${esc(item.title || '（無題）')}</option>`).join('');
  for (const picker of document.querySelectorAll('#project-select,[data-project-picker]')) {
    if (picker._options !== projectsMarkup) { picker.innerHTML = projectsMarkup; picker._options = projectsMarkup; }
    picker.value = state.activeProjectId || ''; picker.disabled = !state.projects.length;
  }
  const episodesMarkup = (owner?.episodes || []).map(item => `<option value="${esc(item.id)}">${esc(item.title || '（無題）')}</option>`).join('');
  for (const picker of document.querySelectorAll('[data-episode-picker]')) {
    if (picker._options !== episodesMarkup) { picker.innerHTML = episodesMarkup; picker._options = episodesMarkup; }
    picker.value = state.activeEpisodeId || ''; picker.disabled = !owner?.episodes.length;
  }
}

function chatMarkup(messages) {
  return messages.map(message => `<li class="msg ${message.role === 'user' ? 'msg-user' : 'msg-ai'}"><p class="msg-who">${message.role === 'user' ? 'あなた' : 'AI'}${message.isExample ? ' · 表示例（実応答ではありません）' : ''}${message.model ? ` · ${esc(message.model)}` : ''}</p><p class="msg-text review-chat-text">${esc(message.content)}</p></li>`).join('');
}

function syncProjectChat(state) {
  const owner = project(state);
  for (const root of document.querySelectorAll('[data-chat-history]')) renderView(root, chatMarkup(owner?.chat.messages || []));
  const role = state.settings.roles.chat;
  for (const label of document.querySelectorAll('[data-chat-model]')) label.textContent = `${role.provider} / ${role.model} · 実AI未接続`;
}

function renderRoles(state) {
  const titles = { chat: 'チャット', writing: '執筆・書き直し', judgment: '講評・判定', background: '要約・背景処理' };
  for (const root of document.querySelectorAll('[data-role-settings]')) {
    const signature = JSON.stringify(state.settings.roles);
    if (root._signature === signature) continue;
    root._signature = signature;
    renderView(root, Object.entries(titles).map(([role, title]) => `<fieldset class="role-setting"><legend>${title}</legend><label>プロバイダー<input class="input" data-role-field="provider" data-role-name="${role}" data-focus-key="role:${role}:provider" value="${esc(state.settings.roles[role].provider)}"></label><label>モデル<input class="input" data-role-field="model" data-role-name="${role}" data-focus-key="role:${role}:model" value="${esc(state.settings.roles[role].model)}"></label></fieldset>`).join(''));
  }
}

async function navigateMain(view) {
  if (!mainViews.includes(view)) return;
  await client.flush();
  if (mountedKind === 'references') await saveView('settings');
  else if (mountedKind === 'project-memos') await saveView('project-memos');
  else await saveView('editor');
  mainView = view;
  const owner = project();
  if (owner && referenceTabs.includes(view) && owner.selection.settingsTab !== view) await client.dispatch('selection.update', { projectId: owner.id, changes: { settingsTab: view } });
  await scheduleRender();
}

async function mountMainPane(state) {
  const owner = project(state);
  if (referenceTabs.includes(mainView)) mainView = owner?.selection.settingsTab || mainView;
  const requested = referenceTabs.includes(mainView) ? 'references' : mainView;
  const panelType = requested === 'references' ? 'settings' : requested;
  const detached = ['references', 'project-memos'].includes(requested) && windows.isDetached(panelType);
  const desired = detached ? 'detached' : requested;
  if (mountedKind !== desired) {
    const returningFromWindow = mountedKind === 'detached';
    await client.flush();
    if (disposeComponent) { await disposeComponent(); disposeComponent = null; }
    for (const pane of document.querySelectorAll('[data-main-pane]')) pane.hidden = pane.dataset.mainPane !== desired;
    if (desired === 'references') disposeComponent = mountReferences(document.getElementById('reference-view'), client, mainView);
    else if (desired === 'project-memos') disposeComponent = mountProjectMemos(document.getElementById('project-memos-view'), client);
    mountedKind = desired;
    if (desired !== 'detached') requestAnimationFrame(() => restoreView(panelType, returningFromWindow));
  }
  if (detached) {
    document.querySelector('[data-detached-description]').textContent = `${labels[panelType]}は別ウィンドウで編集中です。内容と選択状態は共有されています。`;
    document.querySelector('[data-return-active-panel]').dataset.returnActivePanel = panelType;
  }
  for (const button of document.querySelectorAll('[data-main-view]')) button.setAttribute('aria-current', button.dataset.mainView === mainView ? 'page' : 'false');
}

async function renderMain(state) {
  const owner = project(state);
  const current = episode(state);
  document.querySelector('[data-project-title]').textContent = owner?.title || '作品がありません';
  document.querySelector('[data-project-meta]').textContent = owner ? `全${owner.episodes.length}話 · 画面案専用` : '作品管理から追加できます';
  renderView(document.getElementById('episode-list'), (owner?.episodes || []).map((item, index) => `<li draggable="true" data-episode-row="${esc(item.id)}" class="${item.id === state.activeEpisodeId ? 'is-current' : ''}"><button type="button" class="ep" data-episode-id="${esc(item.id)}" ${item.id === state.activeEpisodeId ? 'aria-current="true"' : ''}><span class="ep-no">${index + 1}</span><span class="ep-title">${esc(item.title || '（無題）')}</span></button></li>`).join(''));
  document.querySelector('[data-episode-title]').textContent = current?.title || '本文';
  document.querySelector('[data-episode-order]').textContent = current ? `第${current.order + 1}話` : 'エピソード未選択';
  document.querySelector('[data-word-count]').textContent = current ? `${[...current.content].length.toLocaleString('ja-JP')}文字` : '';
  document.querySelector('[data-no-episode]').hidden = !!current;
  renderView(document.querySelector('[data-project-list]'), state.projects.map(item => `<li class="${item.id === state.activeProjectId ? 'is-current' : ''}"><button type="button" class="btn btn-quiet" data-project-id="${esc(item.id)}">${esc(item.title || '（無題）')}</button><span class="proj-meta">${item.episodes.length}話 · 人物${item.characters.length} · 世界観${item.worldEntries.length}</span></li>`).join(''));
  for (const panel of document.querySelectorAll('[data-docked-panel]')) panel.hidden = windows.isDetached(panel.dataset.dockedPanel);
  await mountMainPane(state);
}

function buildScalarPanel(type) {
  if (type === 'chat') return `<div class="chat-toolbar"><p data-chat-model></p><button type="button" class="btn" data-open-dialog="app-settings">AI設定</button></div><ol class="chat-log" data-chat-history data-scroll-key="project-chat-log" aria-label="作品の会話履歴"></ol><form class="composer"><label for="panel-chat-input">作品チャットの下書き</label><textarea id="panel-chat-input" rows="3" data-project-chat></textarea><div class="composer-foot"><label><input type="checkbox" data-direct-writing> 直接編集</label><span class="composer-note">作品単位で履歴・下書き・選択を共有。実AIは未接続です。</span><button type="button" class="btn-primary" disabled title="実AIが未接続のため送信しません">送信（AI未接続）</button></div></form>`;
  if (type === 'summary') return `<div class="doc-panel scalar-fields"><label>一行要約<input class="input" type="text" data-document-field="oneLiner"></label><label>エピソード要約<textarea rows="12" data-document-field="summary"></textarea></label><p class="review-note">選択中の話に保存します。一行要約と要約本文は別のデータです。</p><button type="button" class="btn" disabled title="実AIは未接続です">要約を生成（AI未接続）</button></div>`;
  return `<div class="doc-panel scalar-fields"><label>エピソードメモ<textarea rows="16" data-document-field="memo"></textarea></label><p class="review-note">この話だけのメモです。作品全体のメモは「プロジェクトメモ」で管理します。</p><button type="button" class="btn" data-detach="project-memos">プロジェクトメモを別窓で開く ↗</button></div>`;
}

function mountPanel(state) {
  const type = client.descriptor.type;
  const root = document.getElementById('panel-root');
  root.dataset.panelScope = type;
  document.querySelector('[data-panel-title]').textContent = labels[type] || '未対応のパネル';
  const isGenre = type === 'genre-chat' || type === 'genre-library';
  document.querySelector('[data-project-context]').hidden = isGenre;
  document.querySelector('[data-follow-note]').hidden = isGenre;
  const genre = state.genres.find(item => item.id === client.descriptor.genreId);
  document.querySelector('[data-panel-context]').textContent = isGenre ? `${genre?.name || 'ジャンル未選択'} · ジャンル固有の会話と資料` : `${project(state)?.title || '作品未選択'} / ${episode(state)?.title || '話未選択'}`;
  if (panelBuilt) return;
  panelBuilt = true;
  if (type === 'settings') disposeComponent = mountReferences(root, client, project(state)?.selection.settingsTab || 'characters');
  else if (type === 'project-memos') disposeComponent = mountProjectMemos(root, client);
  else if (type === 'genre-chat') disposeComponent = mountGenreChat(root, client, client.descriptor.genreId);
  else if (type === 'genre-library') disposeComponent = mountGenreLibrary(root, client);
  else if (['chat', 'summary', 'memo'].includes(type)) root.innerHTML = buildScalarPanel(type);
  else root.textContent = 'この分離対象は登録されていません。主画面から開き直してください。';
  requestAnimationFrame(() => restoreView(type, client.descriptor.detached));
}

async function renderShell(state) {
  syncPickers(state);
  if (surface === 'main') await renderMain(state);
  else if (surface === 'panels') mountPanel(state);
  else if (surface === 'genres' && !panelBuilt) {
    const root = document.querySelector('[data-genre-library-root]');
    root.dataset.panelScope = 'genre-library';
    panelBuilt = true;
    disposeComponent = mountGenreLibrary(root, client);
    requestAnimationFrame(() => restoreView('genre-library'));
  }
  renderRoles(state);
  syncScalars(state);
  syncProjectChat(state);
  for (const root of document.querySelectorAll('[data-windows-tray]')) windows.renderTray(root);
  const editorStatus = document.querySelector('[data-editor-save]');
  if (editorStatus) editorStatus.textContent = drafts.size ? '画面案データを保存中…' : 'ブラウザ保存済み（画面案専用）';
  renderedState = state;
  document.body.dataset.designReady = 'true';
}

function scheduleRender() {
  if (!client.state) return Promise.resolve();
  renderQueue = renderQueue.then(() => renderShell(client.state)).catch(error => { initializationError = error; reportError(error); });
  return renderQueue;
}

function recordDialog(title, description, value, destructive = false) {
  const dialog = document.getElementById('record-dialog');
  dialog.querySelector('h2').textContent = title;
  dialog.querySelector('[data-record-description]').textContent = description;
  const label = dialog.querySelector('[data-record-label]');
  const input = dialog.querySelector('input');
  label.hidden = destructive; input.required = !destructive; input.value = value || '';
  const submit = dialog.querySelector('button[type=submit]');
  submit.textContent = destructive ? '削除する' : '確定';
  submit.classList.toggle('btn-danger-quiet', destructive);
  dialog.returnValue = '';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'accept' ? destructive ? true : input.value.trim() : null), { once: true });
    dialog.showModal();
  });
}

async function projectAction(action, selectedId) {
  await client.flush();
  const owner = project();
  if (selectedId) { await client.dispatch('project.select', { projectId: selectedId }); return; }
  if (action === 'create') {
    const title = await recordDialog('作品を追加', '画面案専用の作品を作成します。実際の作品フォルダには作成しません。', '新しい作品');
    if (title !== null) await client.dispatch('project.create', { title });
  } else if (owner && action === 'rename') {
    const title = await recordDialog('作品名を変更', '対象: ' + owner.title, owner.title);
    if (title !== null) await client.dispatch('project.rename', { projectId: owner.id, title });
  } else if (owner && action === 'delete') {
    if (await recordDialog('作品を削除', `「${owner.title}」の画面案データを削除します。実アプリの作品には影響しません。`, '', true)) await client.dispatch('project.delete', { projectId: owner.id });
  }
}

async function episodeAction(action) {
  await client.flush();
  const owner = project(); const current = episode();
  if (!owner) throw new Error('先に作品を追加してください。');
  if (action === 'create') {
    const title = await recordDialog('エピソードを追加', '対象作品: ' + owner.title, '新しいエピソード');
    if (title !== null) await client.dispatch('episode.create', { projectId: owner.id, title });
  } else if (current && action === 'rename') {
    const title = await recordDialog('エピソード名を変更', '対象作品: ' + owner.title, current.title);
    if (title !== null) await client.dispatch('episode.update', { projectId: owner.id, episodeId: current.id, changes: { title } });
  } else if (current && action === 'delete') {
    if (await recordDialog('エピソードを削除', `「${current.title}」の本文・要約・話別メモ・話別関係を削除します。作品全体のメモは削除しません。`, '', true)) await client.dispatch('episode.delete', { projectId: owner.id, episodeId: current.id });
  } else if (current && ['up', 'down'].includes(action)) {
    const ids = owner.episodes.map(item => item.id); const index = ids.indexOf(current.id); const target = index + (action === 'up' ? -1 : 1);
    if (target >= 0 && target < ids.length) { [ids[index], ids[target]] = [ids[target], ids[index]]; await client.dispatch('episode.reorder', { projectId: owner.id, ids }); }
  }
}

async function exportReview() {
  await client.flush();
  const url = URL.createObjectURL(new Blob([JSON.stringify(client.state, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'litra-ui-review.json'; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Subscribe before components, so old-context UI state is captured before they redraw.
client.subscribe(state => {
  if (renderedState) {
    for (const root of document.querySelectorAll('[data-panel-scope]')) {
      const type = root.dataset.panelScope;
      if (scopeKey(type, renderedState) !== scopeKey(type, state)) saveView(type, renderedState).catch(reportError);
    }
  }
  scheduleRender();
});
client.events.addEventListener('notice', event => reportError(event.detail));

document.addEventListener('input', event => {
  if (event.target._designBinding && !event.isComposing && !composing.has(event.target)) queueDraft(event.target);
});
document.addEventListener('change', event => {
  const field = event.target;
  if (field.matches('#project-select,[data-project-picker]')) {
    const id = field.value; client.flush().then(() => client.dispatch('project.select', { projectId: id })).catch(reportError);
  } else if (field.matches('[data-episode-picker]')) {
    const owner = project(); const id = field.value;
    client.flush().then(() => client.dispatch('episode.select', { projectId: owner.id, episodeId: id })).catch(reportError);
  } else if (field._designBinding) { queueDraft(field); flushDrafts().catch(reportError); }
});
document.addEventListener('compositionstart', event => composing.add(event.target));
document.addEventListener('compositionend', event => {
  composing.delete(event.target);
  if (event.target._designBinding) queueDraft(event.target);
  flushDrafts().then(scheduleRender).catch(reportError);
});
document.addEventListener('focusin', event => {
  const root = event.target.closest('[data-panel-scope]');
  if (root && event.target.dataset.focusKey) focusByScope.set(scopeKey(root.dataset.panelScope), event.target.dataset.focusKey);
});

document.addEventListener('click', event => {
  const button = event.target.closest('[data-detach],[data-reattach],[data-open-main],[data-open-library],[data-main-view],[data-open-dialog],[data-close-dialog],[data-return-active-panel],[data-project-action],[data-project-id],[data-episode-action],[data-episode-id],[data-export-review]');
  if (!button || button.disabled) return;
  event.preventDefault();
  try {
    if (button.hasAttribute('data-detach')) client.openPanel(button.dataset.detach);
    else if (button.hasAttribute('data-open-library')) client.openPanel('genre-library');
    else if (button.hasAttribute('data-reattach')) windows.reattach().catch(reportError);
    else if (button.hasAttribute('data-open-main')) windows.openMain();
    else if (button.hasAttribute('data-main-view')) navigateMain(button.dataset.mainView).catch(reportError);
    else if (button.hasAttribute('data-return-active-panel')) windows.reattach(button.dataset.returnActivePanel).catch(reportError);
    else if (button.hasAttribute('data-open-dialog')) { const dialog = document.getElementById(button.dataset.openDialog); if (dialog && !dialog.open) dialog.showModal(); }
    else if (button.hasAttribute('data-close-dialog')) button.closest('dialog')?.close();
    else if (button.hasAttribute('data-project-action') || button.hasAttribute('data-project-id')) projectAction(button.dataset.projectAction, button.dataset.projectId).catch(reportError);
    else if (button.hasAttribute('data-episode-action')) episodeAction(button.dataset.episodeAction).catch(reportError);
    else if (button.hasAttribute('data-episode-id')) {
      const owner = project(); const id = button.dataset.episodeId;
      client.flush().then(() => client.dispatch('episode.select', { projectId: owner.id, episodeId: id })).then(() => navigateMain('editor')).catch(reportError);
    } else if (button.hasAttribute('data-export-review')) exportReview().catch(reportError);
  } catch (error) { reportError(error); }
});

let draggedEpisode = null;
document.addEventListener('dragstart', event => {
  const row = event.target.closest('[data-episode-row]');
  if (row) { draggedEpisode = { projectId: project().id, id: row.dataset.episodeRow }; event.dataTransfer.setData('text/plain', draggedEpisode.id); }
});
document.addEventListener('dragover', event => { if (draggedEpisode && event.target.closest('[data-episode-row]')) event.preventDefault(); });
document.addEventListener('drop', event => {
  const row = event.target.closest('[data-episode-row]');
  if (!row || !draggedEpisode) return;
  event.preventDefault();
  const dragged = draggedEpisode; draggedEpisode = null;
  const owner = client.state.projects.find(item => item.id === dragged.projectId);
  if (!owner || owner.id !== client.state.activeProjectId) { reportError(new Error('並べ替え中に作品が切り替わりました。')); return; }
  const ids = owner.episodes.map(item => item.id).filter(id => id !== dragged.id);
  ids.splice(ids.indexOf(row.dataset.episodeRow), 0, dragged.id);
  client.flush().then(() => client.dispatch('episode.reorder', { projectId: owner.id, ids })).catch(reportError);
});
document.addEventListener('dragend', () => { draggedEpisode = null; });
window.addEventListener('resize', () => { clearTimeout(geometryTimer); geometryTimer = setTimeout(() => client.saveGeometry(), 200); });
window.addEventListener('focus', () => { if (client.state) client.saveGeometry(); });
window.addEventListener('beforeunload', event => { if (client.hasPending) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', () => { client.saveGeometry(); client.disconnect(); });
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });

try {
  await client.ready;
  await renderQueue;
  if (initializationError) throw initializationError;
  await client.flush();
  if (client.descriptor.detached) {
    const { key, type, genreId, bounds } = client.descriptor;
    await client.dispatch('layout.remember', { descriptor: { key, type, genreId, bounds } });
  }
  requestAnimationFrame(() => client.markReady());
  report('ブラウザ保存済み・画面案専用');
} catch (error) {
  document.body.dataset.designReady = 'false';
  showError(document.querySelector('main') || document.body, error);
  reportError(error);
}
