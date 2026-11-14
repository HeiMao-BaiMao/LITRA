// 資料ビュー（人物 / 世界観 / 関係）とプロジェクトメモの画面案。
//
// すべての表示値は「画面案専用データ・実アプリとは別」の design client から読み、
// すべての変更は client.dispatch 経由で画面案専用 IndexedDB へ実際に CRUD する。
// 実アプリの保存・同期・AI が動作しているわけではない。
//
// 対応する生産実装:
//   frontend-rs/src/windows/settings/render.rs + events.rs（人物・世界観・関係）
//   frontend-rs/src/windows/project_memos.rs（プロジェクトメモ）

import { escapeHTML, renderView, showError } from './view-utils.js';

const UNTITLED = '（無題）';
const DEBOUNCE_MS = 350;
const DESIGN_NOTE = '画面案専用データ・実アプリとは別';

// 生産実装 settings/render.rs CHARACTER_SECTIONS / WORLD_SECTIONS と同一の全フィールド。
// [セクション名, [[キー, ラベル, 複数行], ...]]
const CHARACTER_SECTIONS = [
  ['基本情報', [
    ['name', '名前', false],
    ['reading', 'よみがな', false],
    ['alias', '別名・あだ名', false],
    ['role', '役職・役割', false],
    ['gender', '性別', false],
    ['age', '年齢', false],
    ['birthday', '誕生日', false],
    ['bloodType', '血液型', false],
    ['height', '身長', false],
    ['weight', '体重', false],
  ]],
  ['性格・外見', [
    ['appearance', '見た目', true],
    ['personality', '性格', true],
    ['individuality', '個性', true],
  ]],
  ['能力・経歴', [
    ['skills', '能力・スキル', true],
    ['specialSkills', '特技', true],
    ['upbringing', '生い立ち', true],
    ['background', '背景', true],
  ]],
  ['その他', [
    ['notes', 'メモ', true],
  ]],
];

const WORLD_SECTIONS = [
  ['基本情報', [
    ['name', '名前', false],
    ['category', 'カテゴリ', false],
  ]],
  ['自然・社会', [
    ['era', '時代', false],
    ['geography', '地理・場所', true],
    ['climate', '気候', false],
    ['population', '人口', false],
  ]],
  ['制度・勢力', [
    ['politics', '政治', true],
    ['laws', '法律', true],
    ['economy', '経済', true],
    ['military', '軍事', true],
    ['religion', '宗教', true],
    ['language', '言語', true],
  ]],
  ['文化・歴史', [
    ['culture', '文化', true],
    ['history', '歴史', true],
    ['technology', '技術・魔術体系', true],
  ]],
  ['その他', [
    ['notes', 'メモ', true],
  ]],
];

// 生産実装と同じ direction 値と表示。
const REL_DIRECTIONS = [
  ['a-to-b', 'A → B'],
  ['b-to-a', 'A ← B'],
  ['mutual', 'A ↔ B'],
];

const RESOURCE_TABS = [
  ['characters', '人物'],
  ['world', '世界観'],
  ['relationships', '関係'],
];

const KIND_META = {
  character: {
    label: 'キャラクター',
    listKey: 'characters',
    selectKey: 'characterId',
    sections: CHARACTER_SECTIONS,
    createValues: () => ({ name: '', customFields: [] }),
    createLabel: '＋ 新しいキャラクター',
    emptyLabel: 'キャラクターを選択または作成してください',
    emptyList: 'まだキャラクターが登録されていません。',
  },
  world: {
    label: '世界観',
    listKey: 'worldEntries',
    selectKey: 'worldId',
    sections: WORLD_SECTIONS,
    createValues: () => ({ name: '', category: '', customFields: [] }),
    createLabel: '＋ 新しい世界観',
    emptyLabel: '世界観を選択または作成してください',
    emptyList: 'まだ世界観が登録されていません。',
  },
};

/* ============================ 汎用ヘルパー ============================ */

const esc = value => escapeHTML(value == null ? '' : String(value));
const newId = () => crypto.randomUUID();

function activeProject(state) {
  return state?.projects?.find(p => p.id === state.activeProjectId) ?? null;
}
function selectionOf(project) {
  return project?.selection ?? {};
}
function entityList(project, kind) {
  return project?.[KIND_META[kind].listKey] ?? [];
}
function displayName(entity) {
  const name = (entity?.name ?? '').trim();
  return name === '' ? UNTITLED : name;
}
function entitySubtitle(kind, entity) {
  if (kind === 'character') {
    return [entity?.reading, entity?.role].filter(v => (v ?? '').trim() !== '').join('・');
  }
  return (entity?.category ?? '').trim();
}
function customFieldsOf(entity) {
  return Array.isArray(entity?.customFields) ? entity.customFields : [];
}
function relGroup(project, episodeId) {
  const groups = project?.relationships?.groups;
  if (!Array.isArray(groups)) return [];
  const group = groups.find(g => (g?.episodeId ?? '') === episodeId);
  return Array.isArray(group?.relationships) ? group.relationships : [];
}
function sortedEpisodes(project) {
  return [...(project?.episodes ?? [])].sort((a, b) => (a?.order ?? 0) - (b?.order ?? 0));
}
function formatDateTime(iso) {
  if (!iso) return '';
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return '';
  const d = new Date(time);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function autosize(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

const ICON_PLUS = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
const ICON_TRASH = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3.2h3v1.3M4.5 4.5l.6 8.3h5.8l.6-8.3M6.8 7v3.6M9.2 7v3.6" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_POPOUT = '<svg class="ic" viewBox="0 0 16 16" aria-hidden="true"><path d="M6.5 3.5H3.8v8.7h8.7V9.5M9.5 3.5h3v3M12.2 3.8 8.3 7.7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SR_LABEL = 'ref-sr';

/* ============================ 共有セッション ============================ */
// pending: 入力イベント時点の projectId / entityId / scope を捕捉した未保存編集。
// 切替・別窓化・アンマウントの前に flush して未反映入力を失わない。
// 対象が別画面で削除された場合は失敗を明示し、未保存入力を保持する。

function createSession(root, client) {
  const pending = new Map(); // id -> {type, ...captured}
  const composing = new WeakSet();
  const uid = `u${Math.random().toString(36).slice(2, 8)}`;
  let timer = 0;
  let inFlight = null;
  let latest = null;
  let status = { mode: 'ready', text: '画面案データ — 入力はこのブラウザ内の専用データに自動保存されます' };
  let confirmOpen = false;
  let renderQueued = false;
  let focusKey = null;
  const disposers = [];

  const session = {
    root,
    client,
    pending,
    composing,
    uid,
    get state() { return latest; },
    get hasPending() { return pending.size > 0 || inFlight !== null; },
    get confirmOpen() { return confirmOpen; },
    noteState(next) { latest = next; },

    listen(target, type, handler, options) {
      target.addEventListener(type, handler, options);
      disposers.push(() => target.removeEventListener(type, handler, options));
    },

    setStatus(mode, text) {
      status = { mode, text };
      const el = root.querySelector('[data-ref-status]');
      if (el) {
        el.dataset.statusMode = mode;
        el.textContent = text;
      }
    },
    getStatus() { return status; },
    reportError(error, prefix = '保存に失敗しました') {
      session.setStatus('error', `${prefix} — ${error?.message ?? error}`);
      showError(root, error);
    },

    // id 単位でマージされる遅延コミット。
    schedule(id, item) {
      pending.set(id, item);
      clearTimeout(timer);
      timer = setTimeout(() => { session.flushPending().catch(error => session.reportError(error)); }, DEBOUNCE_MS);
      session.setStatus('pending', '入力を反映中…');
    },
    dropPending(prefix) {
      for (const key of [...pending.keys()]) {
        if (key.startsWith(prefix)) pending.delete(key);
      }
    },
    async commitItem(item) {
      const state = client.state ?? latest;
      const project = state?.projects?.find(p => p.id === item.projectId);
      if (!project) throw new Error('編集対象の作品が別画面で削除されています。未保存入力を保持しています。');
      if (item.type === 'entity-field') {
        if (!entityList(project, item.kind).some(e => e?.id === item.entityId)) throw new Error('編集対象の資料が削除されています。未保存入力を保持しています。');
        await client.dispatch('entity.update', {
          projectId: item.projectId, kind: item.kind, id: item.entityId,
          changes: { [item.field]: item.value },
        });
      } else if (item.type === 'custom-field') {
        const entity = entityList(project, item.kind).find(e => e?.id === item.entityId);
        if (!entity) throw new Error('編集対象の資料が削除されています。未保存入力を保持しています。');
        const fields = customFieldsOf(entity).map(f => ({ label: f?.label ?? '', value: f?.value ?? '' }));
        if (item.index >= fields.length) throw new Error('カスタム項目が別画面で変更されています。未保存入力を保持しています。');
        fields[item.index] = { ...fields[item.index], [item.part]: item.value };
        await client.dispatch('entity.update', {
          projectId: item.projectId, kind: item.kind, id: item.entityId,
          changes: { customFields: fields },
        });
      } else if (item.type === 'rel-field') {
        const rows = relGroup(project, item.episodeId).map(r => ({ ...r }));
        const target = rows.find(r => r.id === item.relId);
        if (!target) throw new Error('編集対象の関係が削除されています。未保存入力を保持しています。');
        target[item.field] = item.value;
        await client.dispatch('relationships.update', {
          projectId: item.projectId, episodeId: item.episodeId, relationships: rows,
        });
      } else if (item.type === 'memo-field') {
        if (!(project.projectMemos ?? []).some(m => m?.id === item.memoId)) throw new Error('編集対象のメモが削除されています。未保存入力を保持しています。');
        await client.dispatch('entity.update', {
          projectId: item.projectId, kind: 'projectMemo', id: item.memoId,
          changes: { [item.field]: item.value },
        });
      }
    },
    async flushPending() {
      clearTimeout(timer);
      timer = 0;
      if (inFlight) {
        await inFlight;
        if (pending.size) await session.flushPending();
        return;
      }
      if (!pending.size) return;
      inFlight = (async () => {
        session.setStatus('saving', '画面案データに保存中…');
        while (pending.size) {
          const [id, item] = pending.entries().next().value;
          try { await session.commitItem(item); }
          catch (error) { session.reportError(error); throw error; }
          if (pending.get(id) === item) pending.delete(id);
        }
        session.setStatus('saved', '画面案データに保存済み（ブラウザ内のみ）');
      })();
      try { await inFlight; }
      finally { inFlight = null; }
    },
    async flush() {
      // IME 変換中のまま切替されると compositionend 前に pending が捕まらないため、
      // 先にフォーカスを外して入力を確定させる
      document.activeElement?.blur?.();
      await session.flushPending();
    },

    // 構造変更の直前に、その対象スコープの pending をマージした値を返す。
    mergedCustomFields(projectId, kind, entityId) {
      const project = latest?.projects?.find(p => p.id === projectId);
      const entity = entityList(project, kind).find(e => e?.id === entityId);
      if (!entity) return null;
      const fields = customFieldsOf(entity).map(f => ({ label: f?.label ?? '', value: f?.value ?? '' }));
      for (const [id, item] of pending) {
        if (item.type === 'custom-field' && item.projectId === projectId &&
            item.kind === kind && item.entityId === entityId && item.index < fields.length) {
          fields[item.index] = { ...fields[item.index], [item.part]: item.value };
          pending.delete(id);
        }
      }
      return fields;
    },
    mergedRelationships(projectId, episodeId) {
      const project = latest?.projects?.find(p => p.id === projectId);
      if (!project) return null;
      const rows = relGroup(project, episodeId).map(r => ({ ...r }));
      for (const [id, item] of pending) {
        if (item.type === 'rel-field' && item.projectId === projectId && item.episodeId === episodeId) {
          const row = rows.find(r => r.id === item.relId);
          if (row) row[item.field] = item.value;
          pending.delete(id);
        }
      }
      return rows;
    },

    requestFocus(key) { focusKey = key; },
    pendingFocusKey() { return focusKey; },
    takeFocusKey() { const key = focusKey; focusKey = null; return key; },

    markRenderQueued() { renderQueued = true; },
    renderIfQueued() {
      if (renderQueued) { renderQueued = false; session.render(); }
    },
    render: null,
    renderWithState(next) {
      latest = next;
      if (confirmOpen) { renderQueued = true; return; }
      session.render();
    },

    async confirm({ title, body, confirmLabel = '削除する' }) {
      const dialog = root.querySelector('dialog[data-ref-confirm]');
      if (!dialog || dialog.open) {
        return window.confirm(`${title}\n${body}`);
      }
      dialog.querySelector('[data-ref-confirm-title]').textContent = title;
      dialog.querySelector('[data-ref-confirm-body]').textContent = body;
      dialog.querySelector('[data-ref-confirm-ok]').textContent = confirmLabel;
      confirmOpen = true;
      const ok = await new Promise(resolve => {
        dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
        dialog.showModal();
      });
      confirmOpen = false;
      session.renderIfQueued();
      return ok;
    },

    async destroy() {
      clearTimeout(timer);
      await session.flushPending();
      for (const dispose of disposers) dispose();
      root.innerHTML = '';
    },
  };
  return session;
}

/* ============================ 共通描画部品 ============================ */

function shellMarkup({ title, note, tabs, activeTab, status, actions, body, uid = '' }) {
  const tabMarkup = tabs ? `
    <div class="ref-tabs" role="tablist" aria-label="資料ビュー切り替え">
      ${tabs.map(([id, label]) => `
        <button type="button" role="tab" class="ref-tab" data-ref-action="tab" data-ref-tab="${esc(id)}"
          id="reftab-${uid}${esc(id)}" aria-controls="refpanel-${uid}${esc(id)}"
          aria-selected="${id === activeTab ? 'true' : 'false'}"
          tabindex="${id === activeTab ? '0' : '-1'}">${esc(label)}</button>`).join('')}
    </div>` : '';
  return `
    <header class="ref-header">
      <div class="ref-header-main">
        <div class="ref-title-row">
          <h2 class="ref-title">${esc(title)}</h2>
          <span class="badge">${esc(DESIGN_NOTE)}</span>
        </div>
        ${note ? `<p class="ref-note">${note}</p>` : ''}
      </div>
      <div class="ref-header-side">
        <p class="ref-status" data-ref-status data-feedback role="status" aria-live="polite"
           data-status-mode="${esc(status.mode)}">${esc(status.text)}</p>
        <div class="ref-actions">${actions ?? ''}</div>
      </div>
    </header>
    ${tabMarkup}
    ${body}`;
}

function confirmDialogMarkup(uid) {
  return `
  <dialog class="dlg ref-confirm" data-ref-confirm aria-labelledby="ref-confirm-title-${uid}">
    <header class="dlg-head">
      <h3 id="ref-confirm-title-${uid}" data-ref-confirm-title></h3>
      <button type="button" class="btn-icon" data-ref-action="confirm-close" aria-label="閉じる">×</button>
    </header>
    <form method="dialog" class="ref-confirm-form">
      <div class="dlg-body"><p class="dlg-note" data-ref-confirm-body></p></div>
      <footer class="dlg-foot">
        <button type="submit" class="btn" value="cancel">キャンセル</button>
        <button type="submit" class="btn ref-btn-danger" value="confirm" data-ref-confirm-ok>削除する</button>
      </footer>
    </form>
  </dialog>`;
}
function emptyState(text, cta = '') {
  return `<div class="ref-empty"><p>${esc(text)}</p>${cta}</div>`;
}

function applyFocus(root, session) {
  const key = session.pendingFocusKey?.();
  if (!key) return;
  const target = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(key) : key.replace(/["\\[\]]/g, '');
  const el = root.querySelector(`[data-focus-key="${target}"]`);
  if (!el) return; // 対象がまだ描画されていなければ次の描画までキーを保持
  session.takeFocusKey();
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select?.();
}

/* ============================ 人物・世界観 ============================ */

function renderEntityList(project, kind, selectedId) {
  const meta = KIND_META[kind];
  const items = entityList(project, kind);
  const rows = items.map(item => {
    const active = item.id === selectedId;
    const sub = entitySubtitle(kind, item);
    return `
      <li class="ref-item${active ? ' is-active' : ''}">
        <button type="button" class="ref-item-main" data-ref-action="select" data-ref-kind="${kind}"
          data-ref-id="${esc(item.id)}" ${active ? 'aria-current="true"' : ''}>
          <span class="ref-item-name">${esc(displayName(item))}</span>
          ${sub ? `<span class="ref-item-sub">${esc(sub)}</span>` : ''}
        </button>
        <button type="button" class="btn-icon ref-item-del" data-ref-action="delete" data-ref-kind="${kind}"
          data-ref-id="${esc(item.id)}" aria-label="${esc(displayName(item))}を削除" title="削除">${ICON_TRASH}</button>
      </li>`;
  }).join('');
  return `
    <div class="ref-side">
      <div class="ref-side-head">
        <button type="button" class="btn btn-small btn-block" data-ref-action="create" data-ref-kind="${kind}">${esc(meta.createLabel)}</button>
        <p class="ref-count">${items.length}件</p>
      </div>
      ${items.length
        ? `<ul class="ref-list" data-scroll-key="ref-list-${kind}">${rows}</ul>`
        : `<p class="ref-side-empty">${esc(meta.emptyList)}</p>`}
    </div>`;
}

function renderFieldControl(kind, entity, projectId, key, label, multiline) {
  const value = entity?.[key] ?? '';
  const focusKey = `f|${projectId}|${kind}|${entity.id}|${key}`;
  const control = multiline
    ? `<textarea class="ref-textarea" rows="3" data-ref-field="${esc(key)}" data-focus-key="${esc(focusKey)}">${esc(value)}</textarea>`
    : `<input type="text" class="input" data-ref-field="${esc(key)}" data-focus-key="${esc(focusKey)}" value="${esc(value)}">`;
  return `<label class="ref-field${multiline ? ' ref-field-wide' : ''}"><span class="ref-field-label">${esc(label)}</span>${control}</label>`;
}

function renderCustomFields(project, kind, entity) {
  const fields = customFieldsOf(entity);
  const rows = fields.map((field, index) => {
    const base = `c|${project.id}|${kind}|${entity.id}|${index}`;
    return `
      <li class="ref-custom-row" data-cf-index="${index}">
        <input type="text" class="input ref-custom-label" placeholder="項目名" aria-label="カスタム項目 ${index + 1} の項目名"
          data-ref-cf-part="label" data-focus-key="${esc(base)}|label" value="${esc(field?.label ?? '')}">
        <textarea class="ref-textarea ref-custom-value" rows="2" placeholder="内容" aria-label="カスタム項目 ${index + 1} の内容"
          data-ref-cf-part="value" data-focus-key="${esc(base)}|value">${esc(field?.value ?? '')}</textarea>
        <button type="button" class="btn-icon ref-custom-del" data-ref-action="custom-delete" data-cf-index="${index}"
          aria-label="カスタム項目 ${index + 1} を削除" title="削除">${ICON_TRASH}</button>
      </li>`;
  }).join('');
  return `
    <section class="ref-section">
      <h4 class="ref-section-title">カスタム項目</h4>
      ${fields.length ? `<ul class="ref-custom-list">${rows}</ul>` : '<p class="ref-section-empty">カスタム項目はまだありません。</p>'}
      <button type="button" class="btn btn-quiet btn-small" data-ref-action="custom-add">${ICON_PLUS} 項目を追加</button>
    </section>`;
}

function renderEntityDetail(project, kind, entity) {
  const meta = KIND_META[kind];
  const sections = meta.sections.map(([title, fields]) => `
    <section class="ref-section">
      <h4 class="ref-section-title">${esc(title)}</h4>
      <div class="ref-fields">
        ${fields.map(([key, label, multiline]) => renderFieldControl(kind, entity, project.id, key, label, multiline)).join('')}
      </div>
    </section>`).join('');
  return `
    <form class="ref-detail" data-ref-form data-project-id="${esc(project.id)}" data-kind="${kind}"
      data-entity-id="${esc(entity.id)}" aria-label="${esc(meta.label)}の編集">
      <div class="ref-detail-head">
        <p class="ref-eyebrow">${esc(meta.label)}</p>
        <h3 class="ref-detail-name">${esc(displayName(entity))}</h3>
      </div>
      ${sections}
      ${renderCustomFields(project, kind, entity)}
      <footer class="ref-detail-foot">
        <button type="button" class="btn btn-danger-quiet" data-ref-action="delete" data-ref-kind="${kind}"
          data-ref-id="${esc(entity.id)}">この${esc(meta.label)}を削除</button>
      </footer>
    </form>`;
}

function renderEntityView(project, kind, uid = '') {
  const meta = KIND_META[kind];
  const panelId = kind === 'character' ? 'characters' : 'world';
  const selectedId = selectionOf(project)[meta.selectKey];
  const selected = entityList(project, kind).find(e => e?.id === selectedId) ?? null;
  return `
    <div class="ref-editor" id="refpanel-${uid}${panelId}" role="tabpanel" aria-labelledby="reftab-${uid}${panelId}">
      ${renderEntityList(project, kind, selectedId)}
      <div class="ref-detail-pane" data-scroll-key="ref-detail-pane">
        ${selected
          ? renderEntityDetail(project, kind, selected)
          : emptyState(meta.emptyLabel,
              entityList(project, kind).length === 0
                ? `<button type="button" class="btn btn-primary" data-ref-action="create" data-ref-kind="${kind}">${esc(meta.createLabel)}</button>`
                : '')}
      </div>
    </div>`;
}

/* ============================ 関係 ============================ */

function characterOptions(characters, selectedId) {
  return `
    <option value="">選択…</option>
    ${characters.map(c => `<option value="${esc(c.id)}"${c.id === selectedId ? ' selected' : ''}>${esc(displayName(c))}</option>`).join('')}`;
}

function renderRelationshipRow(project, episodeId, row, index, uid = '') {
  const characters = entityList(project, 'character');
  const base = `r|${project.id}|${episodeId}|${row.id}`;
  const direction = REL_DIRECTIONS.some(([v]) => v === row.direction) ? row.direction : 'mutual';
  const relId = `${uid}rel-${row.id}`;
  return `
    <li class="rel-row" data-project-id="${esc(project.id)}" data-episode-id="${esc(episodeId)}" data-rel-id="${esc(row.id)}">
      <div class="rel-row-main">
        <span class="rel-badge" aria-hidden="true">A</span>
        <label class="${SR_LABEL}" for="a-${esc(relId)}">キャラクターA</label>
        <select class="input rel-char" id="a-${esc(relId)}" data-ref-rel-field="characterAId" data-focus-key="${esc(base)}|a">
          ${characterOptions(characters, row.characterAId ?? '')}
        </select>
        <label class="${SR_LABEL}" for="dir-${esc(relId)}">関係の方向</label>
        <select class="input rel-dir" id="dir-${esc(relId)}" data-ref-rel-field="direction" data-focus-key="${esc(base)}|dir">
          ${REL_DIRECTIONS.map(([value, label]) => `<option value="${value}"${value === direction ? ' selected' : ''}>${label}</option>`).join('')}
        </select>
        <span class="rel-badge" aria-hidden="true">B</span>
        <label class="${SR_LABEL}" for="b-${esc(relId)}">キャラクターB</label>
        <select class="input rel-char" id="b-${esc(relId)}" data-ref-rel-field="characterBId" data-focus-key="${esc(base)}|b">
          ${characterOptions(characters, row.characterBId ?? '')}
        </select>
        <button type="button" class="btn-icon rel-del" data-ref-action="rel-delete" data-rel-id="${esc(row.id)}"
          aria-label="関係 ${index + 1} を削除" title="削除">${ICON_TRASH}</button>
      </div>
      <input type="text" class="input rel-desc" placeholder="関係の説明（例: 幼なじみ・師弟）"
        aria-label="関係 ${index + 1} の説明" data-ref-rel-field="description"
        data-focus-key="${esc(base)}|desc" value="${esc(row.description ?? '')}">
    </li>`;
}

function renderRelationshipsView(project, uid = '') {
  const scope = selectionOf(project).relationshipEpisodeId ?? '';
  const episodes = sortedEpisodes(project);
  const characters = entityList(project, 'character');
  const rows = relGroup(project, scope);
  const scopeLabel = scope === ''
    ? '全体（全話共通）'
    : ((episodes.find(e => e.id === scope)?.title ?? '').trim() || UNTITLED);
  const noCharacters = characters.length === 0;
  return `
    <div class="ref-editor ref-editor-single" id="refpanel-${uid}relationships" role="tabpanel" aria-labelledby="reftab-${uid}relationships">
      <div class="rel-pane" data-scroll-key="ref-detail-pane">
        <div class="rel-head">
          <div class="rel-head-text">
            <h3 class="ref-detail-name">人間関係</h3>
            <p class="ref-note">AとBを選び、方向と説明を設定します。「全体」は全話共通、話別はそのエピソードだけの関係です。</p>
          </div>
          <label class="ref-scope">
            <span class="ref-field-label">範囲</span>
            <select class="input" data-ref-scope data-focus-key="scope|${esc(project.id)}" aria-label="関係の範囲">
              <option value=""${scope === '' ? ' selected' : ''}>全体（全話共通）</option>
              ${episodes.map(ep => `<option value="${esc(ep.id)}"${ep.id === scope ? ' selected' : ''}>${esc((ep.title ?? '').trim() || UNTITLED)}</option>`).join('')}
            </select>
          </label>
        </div>
        ${noCharacters ? `<div class="rel-warning">${emptyState('関係を登録するには、先にキャラクターを作成してください。',
          '<button type="button" class="btn btn-primary" data-ref-action="goto-tab" data-ref-tab="characters">人物タブで作成</button>')}</div>` : ''}
        ${rows.length
          ? `<ul class="rel-rows" data-scope="${esc(scope)}">
              ${rows.map((row, i) => renderRelationshipRow(project, scope, row, i, uid)).join('')}
            </ul>
            <p class="rel-count">${esc(scopeLabel)}: ${rows.length}件</p>`
          : emptyState(`「${scopeLabel}」にはまだ関係が登録されていません。`)}
        <div class="rel-actions">
          <button type="button" class="btn" data-ref-action="rel-add" data-scope="${esc(scope)}"${noCharacters ? ' disabled title="先にキャラクターを作成してください"' : ''}>
            ${ICON_PLUS} 関係を追加
          </button>
        </div>
      </div>
    </div>`;
}

/* ============================ プロジェクトメモ ============================ */

function memoDisplayTitle(memo) {
  const title = (memo?.title ?? '').trim();
  return title === '' ? UNTITLED : title;
}

function renderMemoList(project, selectedId) {
  const memos = project.projectMemos ?? [];
  const rows = memos.map(memo => {
    const active = memo.id === selectedId;
    const updated = formatDateTime(memo.updatedAt);
    return `
      <li class="ref-item${active ? ' is-active' : ''}">
        <button type="button" class="ref-item-main" data-ref-action="memo-select" data-ref-id="${esc(memo.id)}"
          ${active ? 'aria-current="true"' : ''}>
          <span class="ref-item-name">${esc(memoDisplayTitle(memo))}</span>
          <span class="ref-item-sub">${updated ? `更新 ${esc(updated)}` : '更新日時なし'}</span>
        </button>
        <button type="button" class="btn-icon ref-item-del" data-ref-action="memo-delete" data-ref-id="${esc(memo.id)}"
          aria-label="${esc(memoDisplayTitle(memo))}を削除" title="削除">${ICON_TRASH}</button>
      </li>`;
  }).join('');
  return `
    <div class="ref-side">
      <div class="ref-side-head">
        <button type="button" class="btn btn-small btn-block" data-ref-action="memo-create">${ICON_PLUS} 新しいメモ</button>
        <p class="ref-count">${memos.length}件</p>
      </div>
      ${memos.length
        ? `<ul class="ref-list" data-scroll-key="ref-list-memo">${rows}</ul>`
        : '<p class="ref-side-empty">まだプロジェクトメモがありません。</p>'}
    </div>`;
}

function renderMemoDetail(project, memo) {
  const updated = formatDateTime(memo.updatedAt);
  return `
    <form class="ref-detail" data-ref-form data-project-id="${esc(project.id)}" data-memo-id="${esc(memo.id)}"
      aria-label="プロジェクトメモの編集">
      <div class="ref-detail-head">
        <p class="ref-eyebrow">プロジェクトメモ</p>
        <p class="ref-memo-updated">${updated ? `最終更新: ${esc(updated)}` : '更新日時は保存後に記録されます'}</p>
      </div>
      <label class="ref-field ref-field-wide">
        <span class="ref-field-label">タイトル</span>
        <input type="text" class="input ref-memo-title" placeholder="メモタイトル" data-ref-memo-field="title"
          data-focus-key="m|${esc(project.id)}|${esc(memo.id)}|title" value="${esc(memo.title ?? '')}">
      </label>
      <label class="ref-field ref-field-wide ref-memo-body">
        <span class="ref-field-label">内容</span>
        <textarea class="ref-textarea ref-memo-content" placeholder="内容を自由に書いてください…" spellcheck="false"
          data-ref-memo-field="content" data-ref-autosize
          data-focus-key="m|${esc(project.id)}|${esc(memo.id)}|content">${esc(memo.content ?? '')}</textarea>
      </label>
      <footer class="ref-detail-foot">
        <button type="button" class="btn btn-danger-quiet" data-ref-action="memo-delete" data-ref-id="${esc(memo.id)}">このメモを削除</button>
      </footer>
    </form>`;
}

function renderMemoView(project) {
  const selectedId = selectionOf(project).projectMemoId;
  const selected = (project.projectMemos ?? []).find(m => m?.id === selectedId) ?? null;
  return `
    <div class="ref-editor">
      ${renderMemoList(project, selectedId)}
      <div class="ref-detail-pane" data-scroll-key="ref-detail-pane">
        ${selected
          ? renderMemoDetail(project, selected)
          : emptyState('メモを選択または作成してください',
              (project.projectMemos ?? []).length === 0
                ? `<button type="button" class="btn btn-primary" data-ref-action="memo-create">${ICON_PLUS} 新しいメモ</button>`
                : '')}
      </div>
    </div>`;
}

/* ============================ 入力・操作の配線 ============================ */

function bindView(session, handlers) {
  const { root, client } = session;
  const fail = error => session.reportError(error, '操作に失敗しました');

  session.listen(root, 'click', event => {
    const control = event.target.closest('[data-ref-action]');
    if (!control || control.disabled || !root.contains(control)) return;
    const action = control.dataset.refAction;
    if (action === 'confirm-close') {
      control.closest('dialog')?.close('cancel');
      return;
    }
    event.preventDefault();
    void Promise.resolve(handlers[action]?.(control, event)).catch(fail);
  });

  session.listen(root, 'input', event => {
    const el = event.target;
    if (!(el instanceof HTMLElement)) return;
    if (event.isComposing || session.composing.has(el)) {
      session.composing.add(el);
      return;
    }
    try {
      handlers.onField?.(el);
    } catch (error) { fail(error); }
  });

  session.listen(root, 'compositionstart', event => {
    if (event.target instanceof HTMLElement) session.composing.add(event.target);
  });
  session.listen(root, 'compositionend', event => {
    const el = event.target;
    if (el instanceof HTMLElement && session.composing.has(el)) {
      session.composing.delete(el);
      try {
        handlers.onField?.(el);
      } catch (error) { fail(error); }
    }
  });

  // select・チェンジ系コントロール（input が飛ばない経路向け）
  session.listen(root, 'change', event => {
    const el = event.target;
    if (!(el instanceof HTMLElement)) return;
    void Promise.resolve(handlers.onChange?.(el)).catch(fail);
  });

  // タブの矢印キー操作（Home/End/←/→）
  session.listen(root, 'keydown', event => {
    const tab = event.target.closest?.('[data-ref-action="tab"]');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...root.querySelectorAll('[data-ref-action="tab"]')];
    let index = tabs.indexOf(tab);
    if (index < 0) return;
    if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = tabs.length - 1;
    else index = (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    void Promise.resolve(handlers.switchTab?.(tabs[index].dataset.refTab, { focus: true })).catch(fail);
  });

  session.listen(root, 'submit', event => {
    // ダイアログ内の method="dialog" フォームはそのまま（preventDefault すると閉じない）
    if (!(event.target instanceof HTMLFormElement) || !event.target.closest('dialog')) {
      event.preventDefault();
    }
  });
  session.listen(window, 'pagehide', () => { session.flush().catch(error => session.reportError(error)); });

  const unsubscribe = client.subscribe(state => session.renderWithState(state));
  const unregisterFlusher = client.addFlusher(() => session.flush(), () => session.hasPending);

  return async () => {
    await session.flush();
    unsubscribe();
    unregisterFlusher();
    await session.destroy();
  };
}

/* ============================ mountReferences ============================ */

export function mountReferences(root, client, initialTab = 'characters') {
  const session = createSession(root, client);
  let state = null;

  const currentTab = () => {
    const tab = selectionOf(activeProject(state)).settingsTab || initialTab;
    return RESOURCE_TABS.some(([id]) => id === tab) ? tab : 'characters';
  };

  async function dispatchSelect(projectId, changes) {
    // 別 ID への切替前に保留中の編集を確定する
    await session.flush();
    await client.dispatch('selection.update', { projectId, changes });
  }

  const handlers = {
    async tab(control) {
      await handlers.switchTab(control.dataset.refTab);
    },
    async switchTab(tabId, opts = {}) {
      const project = activeProject(state);
      const target = RESOURCE_TABS.some(([id]) => id === tabId) ? tabId : 'characters';
      if (project && target !== currentTab()) {
        await dispatchSelect(project.id, { settingsTab: target });
      }
      if (opts.focus) root.querySelector(`[data-ref-action="tab"][data-ref-tab="${target}"]`)?.focus();
    },
    'goto-tab': control => handlers.switchTab(control.dataset.refTab),

    async create(control) {
      const kind = control.dataset.refKind;
      const project = activeProject(state);
      if (!project || !KIND_META[kind]) return;
      await session.flush();
      const { id } = await client.dispatch('entity.create', {
        projectId: project.id, kind, values: KIND_META[kind].createValues(),
      });
      await client.dispatch('selection.update', {
        projectId: project.id, changes: { [KIND_META[kind].selectKey]: id },
      });
      session.requestFocus(`f|${project.id}|${kind}|${id}|name`);
    },

    async select(control) {
      const project = activeProject(state);
      const kind = control.dataset.refKind;
      if (!project || !KIND_META[kind]) return;
      await dispatchSelect(project.id, { [KIND_META[kind].selectKey]: control.dataset.refId });
    },

    async delete(control) {
      const kind = control.dataset.refKind;
      const id = control.dataset.refId;
      const project = activeProject(state);
      if (!project || !KIND_META[kind]) return;
      const entity = entityList(project, kind).find(e => e?.id === id);
      const ok = await session.confirm({
        title: `${KIND_META[kind].label}の削除`,
        body: `「${displayName(entity)}」を削除しますか？この操作は画面案データから取り消せません。`,
      });
      if (!ok) return;
      session.dropPending(`e|${kind}|${id}|`);
      session.dropPending(`c|${project.id}|${kind}|${id}|`);
      await session.flush();
      await client.dispatch('entity.delete', { projectId: project.id, kind, id });
    },

    async 'custom-add'(control) {
      const form = control.closest('[data-ref-form]');
      const { projectId, kind, entityId } = form?.dataset ?? {};
      if (!projectId || !kind || !entityId) return;
      const fields = session.mergedCustomFields(projectId, kind, entityId);
      if (!fields) return;
      fields.push({ label: '', value: '' });
      session.requestFocus(`c|${projectId}|${kind}|${entityId}|${fields.length - 1}|label`);
      await client.dispatch('entity.update', {
        projectId, kind, id: entityId, changes: { customFields: fields },
      });
    },

    async 'custom-delete'(control) {
      const form = control.closest('[data-ref-form]');
      const { projectId, kind, entityId } = form?.dataset ?? {};
      const index = Number(control.dataset.cfIndex);
      if (!projectId || !Number.isInteger(index)) return;
      const fields = session.mergedCustomFields(projectId, kind, entityId);
      if (!fields || index >= fields.length) return;
      const target = fields[index];
      if ((target.label ?? '').trim() !== '' || (target.value ?? '').trim() !== '') {
        const ok = await session.confirm({
          title: 'カスタム項目の削除',
          body: `「${(target.label ?? '').trim() || `項目 ${index + 1}`}」を削除しますか？`,
        });
        if (!ok) return;
      }
      fields.splice(index, 1);
      // インデックスがずれるため、このエンティティのカスタム項目 pending は全て破棄して最新値で置き換える
      session.dropPending(`c|${projectId}|${kind}|${entityId}|`);
      await client.dispatch('entity.update', {
        projectId, kind, id: entityId, changes: { customFields: fields },
      });
    },

    async 'rel-add'(control) {
      const project = activeProject(state);
      if (!project) return;
      const episodeId = control.dataset.scope ?? '';
      const rows = session.mergedRelationships(project.id, episodeId);
      if (!rows) return;
      const row = { id: newId(), characterAId: '', characterBId: '', direction: 'mutual', description: '' };
      rows.push(row);
      session.requestFocus(`r|${project.id}|${episodeId}|${row.id}|a`);
      await client.dispatch('relationships.update', {
        projectId: project.id, episodeId, relationships: rows,
      });
    },

    async 'rel-delete'(control) {
      const project = activeProject(state);
      const rowEl = control.closest('.rel-row');
      const episodeId = rowEl?.dataset.episodeId ?? '';
      const relId = control.dataset.relId;
      if (!project || !relId) return;
      const rows = session.mergedRelationships(project.id, episodeId);
      if (!rows) return;
      const target = rows.find(r => r.id === relId);
      if (!target) return;
      const hasContent = Boolean(target.characterAId || target.characterBId || (target.description ?? '').trim());
      if (hasContent) {
        const names = [target.characterAId, target.characterBId]
          .map(cid => entityList(project, 'character').find(c => c?.id === cid))
          .map(c => (c ? displayName(c) : '未選択'));
        const ok = await session.confirm({
          title: '関係の削除',
          body: `「${names[0]} と ${names[1]}」${(target.description ?? '').trim() ? `（${target.description.trim()}）` : ''}の関係を削除しますか？`,
        });
        if (!ok) return;
      }
      session.dropPending(`r|${project.id}|${episodeId}|${relId}|`);
      await client.dispatch('relationships.update', {
        projectId: project.id, episodeId,
        relationships: rows.filter(r => r.id !== relId),
      });
    },

    'open-settings': () => client.openPanel?.('settings'),
    'open-memos': () => client.openPanel?.('project-memos'),

    onField(el) {
      // 通常フィールド
      if (el.dataset.refField) {
        const form = el.closest('[data-ref-form]');
        const { projectId, kind, entityId } = form?.dataset ?? {};
        if (!projectId || !kind || !entityId) return;
        session.schedule(`e|${kind}|${entityId}|${el.dataset.refField}`, {
          type: 'entity-field', projectId, kind, entityId,
          field: el.dataset.refField, value: el.value,
        });
        return;
      }
      // カスタム項目
      if (el.dataset.refCfPart) {
        const form = el.closest('[data-ref-form]');
        const row = el.closest('[data-cf-index]');
        const { projectId, kind, entityId } = form?.dataset ?? {};
        const index = Number(row?.dataset.cfIndex);
        if (!projectId || !kind || !entityId || !Number.isInteger(index)) return;
        session.schedule(`c|${projectId}|${kind}|${entityId}|${index}|${el.dataset.refCfPart}`, {
          type: 'custom-field', projectId, kind, entityId, index,
          part: el.dataset.refCfPart, value: el.value,
        });
        return;
      }
      // 関係の説明（debounce。A/B/方向の select は onChange で即時コミット）
      if (el.dataset.refRelField === 'description') {
        const row = el.closest('[data-rel-id]');
        if (!row) return;
        session.schedule(`r|${row.dataset.projectId}|${row.dataset.episodeId}|${row.dataset.relId}|description`, {
          type: 'rel-field', projectId: row.dataset.projectId, episodeId: row.dataset.episodeId,
          relId: row.dataset.relId, field: 'description', value: el.value,
        });
      }
    },

    async onChange(el) {
      const project = activeProject(state);
      if (!project) return;
      // 範囲セレクト — 保留編集を確定してから切替
      if (el.hasAttribute('data-ref-scope')) {
        await dispatchSelect(project.id, { relationshipEpisodeId: el.value });
        return;
      }
      // 関係の A/B/方向 — 即時コミット
      const relField = el.dataset.refRelField;
      if (relField && relField !== 'description') {
        const row = el.closest('[data-rel-id]');
        if (!row) return;
        const rows = session.mergedRelationships(row.dataset.projectId, row.dataset.episodeId);
        if (!rows) return;
        const target = rows.find(r => r.id === row.dataset.relId);
        if (!target) return;
        target[relField] = el.value;
        await client.dispatch('relationships.update', {
          projectId: row.dataset.projectId, episodeId: row.dataset.episodeId,
          relationships: rows,
        });
      }
    },
  };

  session.renderWithState = next => {
    state = next;
    session.noteState(next);
    if (session.confirmOpen) { session.markRenderQueued(); return; }
    session.render();
  };

  session.render = () => {
    const project = activeProject(state);
    const tab = project ? currentTab() : 'characters';
    const content = !project ? ''
      : tab === 'characters' ? renderEntityView(project, 'character', session.uid)
      : tab === 'world' ? renderEntityView(project, 'world', session.uid)
      : renderRelationshipsView(project, session.uid);
    const body = !project
      ? `<div class="ref-body">${emptyState('作品が選択されていません。主画面で作品を選択すると資料を編集できます。')}</div>`
      : `<div class="ref-body">${content}</div>`;
    const actions = typeof client.openPanel === 'function' ? `
      <button type="button" class="btn btn-quiet btn-small" data-ref-action="open-memos">${ICON_POPOUT} プロジェクトメモを別窓で</button>
      <button type="button" class="btn btn-quiet btn-small" data-ref-action="open-settings">${ICON_POPOUT} 設定を別窓で</button>` : '';
    renderView(root, `
      <section class="ref-root" aria-label="作品資料">
        ${shellMarkup({
          title: '作品資料',
          note: '人物・世界観・関係の設定を管理します。変更は画面案専用データに自動保存されます。',
          tabs: project ? RESOURCE_TABS : null,
          activeTab: tab,
          status: session.getStatus(),
          actions,
          body,
          uid: session.uid,
        })}
        ${confirmDialogMarkup(session.uid)}
      </section>`);
    applyFocus(root, session);
  };

  root.innerHTML = '<section class="ref-root"><p class="ref-loading" role="status">画面案データを読み込み中…</p></section>';
  return bindView(session, handlers);
}

/* ============================ mountProjectMemos ============================ */

export function mountProjectMemos(root, client) {
  const session = createSession(root, client);
  let state = null;

  const handlers = {
    async 'memo-create'() {
      const project = activeProject(state);
      if (!project) return;
      await session.flush();
      const { id } = await client.dispatch('entity.create', {
        projectId: project.id, kind: 'projectMemo', values: { title: '', content: '' },
      });
      await client.dispatch('selection.update', {
        projectId: project.id, changes: { projectMemoId: id },
      });
      session.requestFocus(`m|${project.id}|${id}|title`);
    },

    async 'memo-select'(control) {
      const project = activeProject(state);
      if (!project) return;
      await session.flush();
      await client.dispatch('selection.update', {
        projectId: project.id, changes: { projectMemoId: control.dataset.refId },
      });
    },

    async 'memo-delete'(control) {
      const project = activeProject(state);
      const id = control.dataset.refId;
      if (!project || !id) return;
      const memo = (project.projectMemos ?? []).find(m => m?.id === id);
      const ok = await session.confirm({
        title: 'プロジェクトメモの削除',
        body: `「${memoDisplayTitle(memo)}」を削除しますか？この操作は画面案データから取り消せません。`,
      });
      if (!ok) return;
      session.dropPending(`m|${project.id}|${id}|`);
      await session.flush();
      await client.dispatch('entity.delete', { projectId: project.id, kind: 'projectMemo', id });
    },

    'open-memos': () => client.openPanel?.('project-memos'),

    onField(el) {
      const field = el.dataset.refMemoField;
      if (!field) return;
      const form = el.closest('[data-ref-form]');
      const { projectId, memoId } = form?.dataset ?? {};
      if (!projectId || !memoId) return;
      if (el.hasAttribute('data-ref-autosize')) autosize(el);
      session.schedule(`m|${projectId}|${memoId}|${field}`, {
        type: 'memo-field', projectId, memoId, field, value: el.value,
      });
    },
  };

  session.renderWithState = next => {
    state = next;
    session.noteState(next);
    if (session.confirmOpen) { session.markRenderQueued(); return; }
    session.render();
  };

  session.render = () => {
    const project = activeProject(state);
    const body = !project
      ? `<div class="ref-body">${emptyState('作品が選択されていません。主画面で作品を選択するとメモを編集できます。')}</div>`
      : `<div class="ref-body">${renderMemoView(project)}</div>`;
    const actions = typeof client.openPanel === 'function'
      ? `<button type="button" class="btn btn-quiet btn-small" data-ref-action="open-memos">${ICON_POPOUT} 別窓で開く</button>`
      : '';
    renderView(root, `
      <section class="ref-root" aria-label="プロジェクトメモ">
        ${shellMarkup({
          title: 'プロジェクトメモ',
          note: '作品全体のメモです。エピソードごとのメモ（エピソードメモ）とは別に管理されます。',
          tabs: null,
          status: session.getStatus(),
          actions,
          body,
          uid: session.uid,
        })}
        ${confirmDialogMarkup(session.uid)}
      </section>`);
    root.querySelectorAll('[data-ref-autosize]').forEach(autosize);
    applyFocus(root, session);
  };

  root.innerHTML = '<section class="ref-root"><p class="ref-loading" role="status">画面案データを読み込み中…</p></section>';
  return bindView(session, handlers);
}
