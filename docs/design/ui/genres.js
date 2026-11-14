// LITRA 画面案 — ジャンルライブラリ / ジャンルチャット コンポーネント。
// 親ランタイム(app.js)が mountGenreLibrary(root, client) / mountGenreChat(root, client, genreId) を呼ぶ。
// すべての書き込みは client.dispatch 経由。AI実行・プロバイダ接続は画面案では行わず、
// その操作は「未接続」であることと本来の送信内容を明示する。完了・応答は捏造しない。

import { escapeHTML as ESC, renderView, showError } from './view-utils.js';

/* ---------- 語彙（本番: data/genres/models.rs, prompts.rs 準拠） ---------- */

const ANALYSIS_STATUS = {
  not_analyzed: '未分析',
  analyzing: '分析中',
  completed: '分析済み',
  partial: '一部失敗',
  failed: '失敗',
};

const CATEGORIES = [
  ['definition', '定義'],
  ['core_requirement', '中核要件'],
  ['frequent_feature', '頻出要素'],
  ['optional_feature', '任意要素'],
  ['boundary_condition', '境界条件'],
  ['genre_differentiator', '差別化要素'],
  ['prose_style', '文体'],
  ['narrative_structure', '物語構造'],
  ['scene_pattern', '場面パターン'],
  ['character_function', '人物機能'],
  ['worldbuilding_function', '世界構築機能'],
  ['reader_contract', '読者との約束'],
  ['emotional_effect', '感情効果'],
  ['generation_guidance', '生成指針'],
  ['prohibition', '禁止事項'],
  ['failure_mode', '失敗パターン'],
  ['evaluation_criterion', '評価基準'],
  ['narrative', '物語'],
  ['structure', '構造'],
  ['general', '一般'],
];

const IMPORTANCE = [
  ['core', '中核'],
  ['frequent', '頻出'],
  ['optional', '任意'],
  ['boundary', '境界'],
  ['work_specific', '作品固有'],
];

const SOURCE_TYPES = [
  ['novel', '小説'],
  ['short_story', '短編'],
  ['essay', '随筆・評論'],
  ['review', '批評・レビュー'],
  ['interview', 'インタビュー'],
  ['manual', '手引き・ガイド'],
  ['other', 'その他'],
];

const SOURCE_ROLES = [
  ['partial_example', '部分的な実例'],
  ['primary_example', '代表的な実例'],
  ['counter_example', '対比例'],
  ['reference', '参考資料'],
];

const PREFERENCES = [
  ['neutral', '中立'],
  ['emulate', '手本にしたい'],
  ['avoid', '避けたい'],
];

const MEDIA_TYPES = [
  ['text/markdown', 'text/markdown'],
  ['text/plain', 'text/plain'],
];

const AUTHORITIES = {
  user: 'ユーザー入力',
  user_explicit: 'ユーザー明示',
  user_approved: 'ユーザー承認',
  user_approved_ai: 'AI候補をユーザー採用',
  ai: 'AI',
  ai_candidate: 'AI候補',
  ai_generated: 'AI生成',
  source_analysis: '資料分析',
};

const CANDIDATE_STATUS_LABEL = {
  accepted: '採用しました（採用済み知識に追加）',
  on_hold: '保留にしました',
  rejected: '却下しました',
  pending: '未確認に戻しました',
};

const GENRE_STATUS = {
  active: '有効',
  archived: 'アーカイブ済み',
};


/* ---------- 小さなユーティリティ ---------- */

function label(map, value) {
  if (value == null || value === '') return '—';
  if (Array.isArray(map)) {
    const hit = map.find(([k]) => k === value);
    return hit ? hit[1] : value;
  }
  return map[value] ?? value;
}

function esc(session, value) {
  return ESC(value);
}

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtNum(value) {
  return Number.isFinite(value) ? value.toLocaleString('ja-JP') : '0';
}

function fmtConfidence(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—';
}

function fmtSize(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

function splitList(value) {
  return String(value ?? '')
    .split(/[,、\n]/)
    .map(v => v.trim())
    .filter(Boolean);
}

// 画面案データのセグメント startOffset/endOffset は JS文字列インデックス
// （design-model.js の segmentSource が match.index を使う）
function sliceSegment(text, start, end) {
  const s = Math.max(0, Number(start) || 0);
  const e = Math.max(s, Number(end) || 0);
  return String(text ?? '').slice(s, e);
}

function describeRef(ref, sourceById) {
  if (ref == null) return '';
  if (typeof ref === 'string') {
    const hit = sourceById?.get(ref);
    return hit ? hit.title : ref;
  }
  const sourceId = ref.sourceId || ref.source_id || '';
  const hit = sourceId && sourceById?.get(sourceId);
  const title = ref.title || ref.sourceTitle || ref.name || (hit ? hit.title : sourceId) || '';
  const seg = ref.segmentId && hit?.segments?.find(sg => sg.id === ref.segmentId);
  const heading = ref.segmentHeading || ref.heading || seg?.heading || '';
  const quote = ref.quote || ref.content || '';
  const head = [title, heading].filter(Boolean).join(' / ');
  if (quote) return head ? `${head}：「${quote}」` : `「${quote}」`;
  return head || JSON.stringify(ref);
}
function errorMessage(error) {
  if (!error) return '不明なエラーが発生しました。';
  if (typeof error === 'string') return error;
  return error.message || String(error);
}

function isConflict(error) {
  const code = String(error?.code ?? '');
  const msg = String(error?.message ?? error ?? '');
  return /conflict|revision|stale|409|競合/i.test(`${code} ${msg}`);
}

/* ---------- セッション（マウント単位の状態） ---------- */

function createSession(root, client, renderFn) {
  const session = {
    root,
    client,
    state: null,
    mounted: true,
    feedback: null,
    pending: new Map(),   // key -> {kind, merge, timer, failed, apply, exists, running}
    busy: new Set(),
    dialogs: new Set(),
    listeners: [],
    cleanups: [],
    genreId: null,
    lastScrollSig: '',
    afterRender: null,
    render: null,
    _dialogResult: null,
  };
  session.render = () => {
    if (!session.mounted) return;
    renderView(root, renderFn(session));
    applyFeedback(session);
    applySaveBadges(session);
    applyBusy(session);
    session.afterRender?.(session);
  };
  listen(session, document, 'compositionstart', event => {
    if (event.target?.dataset) event.target.dataset.composing = 'true';
  }, true);
  listen(session, document, 'compositionend', event => {
    if (event.target?.dataset) delete event.target.dataset.composing;
  }, true);
  return session;
}

function listen(session, target, type, fn, options) {
  target.addEventListener(type, fn, options);
  session.listeners.push(() => target.removeEventListener(type, fn, options));
}

function setFeedback(session, message, kind = 'info') {
  session.feedback = message ? { message, kind } : null;
  applyFeedback(session);
}

function applyFeedback(session) {
  const slot = session.root.querySelector('[data-feedback]');
  if (!slot) return;
  const fb = session.feedback;
  slot.hidden = !fb;
  if (fb) {
    slot.textContent = fb.message;
    slot.dataset.kind = fb.kind;
  } else {
    slot.textContent = '';
    delete slot.dataset.kind;
  }
}

function reportError(session, error) {
  const message = isConflict(error)
    ? '別の画面で先に更新されました（リビジョン競合）。最新の内容が表示されているか確認してからもう一度入力してください。'
    : `保存できませんでした：${errorMessage(error)}`;
  setFeedback(session, message, 'error');
  showError(session.root, message);
}

/* ---------- 自動保存（デバウンス + addFlusher + change時即時ドレイン） ---------- */

function schedule(session, key, kind, merge, entry, apply, exists) {
  let item = session.pending.get(key);
  if (!item) {
    item = { kind, merge: {}, entry, failed: false, timer: null, apply, exists, running: false };
    session.pending.set(key, item);
  }
  Object.assign(item.merge, merge);
  item.entry = entry;
  item.failed = false;
  clearTimeout(item.timer);
  item.timer = setTimeout(() => { item.timer = null; drainKey(session, key).catch(error => reportError(session, error)); }, 600);
  applySaveBadges(session);
}

function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

async function drainKey(session, key) {
  const item = session.pending.get(key);
  if (!item) return;
  if (item.flight) return item.flight;
  clearTimeout(item.timer);
  item.timer = null;
  item.running = true;
  const snapshot = { ...item.merge };
  const operation = (async () => {
    if (item.exists && !item.exists()) throw new Error('編集対象が別画面で削除されています。未保存入力を保持しています。');
    await item.apply(snapshot);
    if (session.pending.get(key) !== item) return;
    for (const [field, value] of Object.entries(item.merge)) {
      if (sameValue(value, snapshot[field])) delete item.merge[field];
    }
    if (Object.keys(item.merge).length) {
      item.timer = setTimeout(() => { item.timer = null; drainKey(session, key).catch(error => reportError(session, error)); }, 120);
    } else {
      session.pending.delete(key);
    }
  })();
  item.flight = operation;
  try { await operation; }
  catch (error) {
    item.failed = true;
    reportError(session, error);
    throw error;
  } finally {
    item.running = false;
    item.flight = null;
    applySaveBadges(session);
  }
}

function dropPending(session, key) {
  const item = session.pending.get(key);
  if (!item) return;
  clearTimeout(item.timer);
  session.pending.delete(key);
  applySaveBadges(session);
}

async function drainAll(session) {
  while (session.pending.size) {
    for (const key of [...session.pending.keys()]) await drainKey(session, key);
  }
}

async function flushSession(session) {
  if ([...session.dialogs].some(dialog => dialog.open)) {
    throw new Error('入力中のダイアログを確定またはキャンセルしてから画面を切り替えてください。');
  }
  await drainAll(session);
}

function applySaveBadges(session) {
  session.root.querySelectorAll('[data-save-state]').forEach(el => {
    const item = session.pending.get(el.dataset.saveState);
    if (item?.failed) {
      el.textContent = '保存エラー';
      el.dataset.state = 'failed';
    } else if (item) {
      el.textContent = '保存中…';
      el.dataset.state = 'pending';
    } else {
      el.textContent = '';
      delete el.dataset.state;
    }
  });
}

function applyBusy(session) {
  session.root.querySelectorAll('[data-busy-key]').forEach(el => {
    const on = session.busy.has(el.dataset.busyKey);
    if ('disabled' in el) el.disabled = on;
    el.setAttribute('aria-busy', on ? 'true' : 'false');
  });
}

async function run(session, busyKey, job) {
  if (session.busy.has(busyKey)) return;
  session.busy.add(busyKey);
  applyBusy(session);
  try {
    await job();
  } catch (error) {
    reportError(session, error);
  } finally {
    session.busy.delete(busyKey);
    applyBusy(session);
  }
}

/* ---------- ダイアログ（Escape・フォーカス管理・削除確認） ---------- */

// markup は dlg-body + dlg-foot を含む。フォームは method="dialog"。
// .dlg-foot は genres.css で row-reverse。OKボタンを先に置き Enter の暗黙送信をそれに合わせる。
function openDialog(session, { title, markup, prepare }) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'dlg gl-dlg';
    const headingId = `gl-dlg-${Math.random().toString(36).slice(2)}`;
    dlg.setAttribute('aria-labelledby', headingId);
    dlg.innerHTML = `
      <header class="dlg-head">
        <h3 id="${esc(session, headingId)}">${esc(session, title)}</h3>
        <button type="button" class="btn-icon" data-dlg-cancel aria-label="閉じる">×</button>
      </header>
      ${markup}`;
    const invoker = document.activeElement;
    dlg.addEventListener('click', event => {
      if (event.target.closest('[data-dlg-cancel]')) {
        dlg.returnValue = '__cancel__';
        dlg.close('__cancel__');
      }
    });
    // 入力値の回収を Promise の解決より先に登録する。
    prepare?.(dlg);
    dlg.addEventListener('close', () => {
      const value = dlg.returnValue;
      session.dialogs.delete(dlg);
      dlg.remove();
      if (invoker && typeof invoker.focus === 'function' && document.contains(invoker)) {
        try { invoker.focus({ preventScroll: true }); } catch { /* noop */ }
      }
      resolve(value === '__cancel__' || value === '' ? null : value);
    });
    session.dialogs.add(dlg);
    document.body.appendChild(dlg);
    // method="dialog" でも submit イベントは発火するので必須チェックをここで行う
    const form = dlg.querySelector('form');
    if (form) {
      form.addEventListener('submit', event => {
        if (!form.reportValidity()) {
          event.preventDefault();
          event.stopPropagation();
        }
      });
    }
    try { dlg.showModal(); } catch { dlg.setAttribute('open', ''); }
    const first = dlg.querySelector('[autofocus], input:not([type="hidden"]), textarea, select');
    if (first && typeof first.focus === 'function') {
      try { first.focus({ preventScroll: true }); } catch { /* noop */ }
    }
  });
}

async function confirmDialog(session, { title, body, okLabel = '削除する' }) {
  const value = await openDialog(session, {
    title,
    markup: `
      <form method="dialog" class="gl-dialog-form">
        <div class="dlg-body"><p class="gl-confirm-body">${body}</p></div>
        <footer class="dlg-foot">
          <button type="submit" class="btn btn-danger-quiet" value="ok">${esc(session, okLabel)}</button>
          <button type="button" class="btn" data-dlg-cancel>キャンセル</button>
        </footer>
      </form>`,
  });
  return value === 'ok';
}

// 単一入力プロンプト。close 時にフォーム値を読んで resolve する。
function promptDialog(session, { title, label, value = '', okLabel = '保存', required = true, multiline = false }) {
  return new Promise(resolve => {
    const inputMarkup = multiline
      ? `<textarea name="v" rows="4" ${required ? 'required' : ''} autofocus>${esc(session, value)}</textarea>`
      : `<input class="input" name="v" value="${esc(session, value)}" ${required ? 'required' : ''} autofocus>`;
    let settled = false;
    openDialog(session, {
      title,
      markup: `
        <form method="dialog" class="gl-dialog-form">
          <div class="dlg-body">
            <label class="field"><span class="gl-field-label">${esc(session, label)}</span>${inputMarkup}</label>
          </div>
          <footer class="dlg-foot">
            <button type="submit" class="btn btn-primary" value="ok">${esc(session, okLabel)}</button>
            <button type="button" class="btn" data-dlg-cancel>キャンセル</button>
          </footer>
        </form>`,
      prepare(dlg) {
        dlg.addEventListener('close', () => {
          if (settled) return;
          settled = true;
          if (dlg.returnValue !== 'ok') { resolve(null); return; }
          const field = dlg.querySelector('[name="v"]');
          resolve(field ? field.value : null);
        });
      },
    }).then(() => {
      if (!settled) { settled = true; resolve(null); }
    });
  });
}

// 複数フィールドのフォーム用: close 前に FormData を session._dialogResult へ退避
function captureForm(session, dlg) {
  dlg.addEventListener('close', () => {
    session._dialogResult = null;
    if (dlg.returnValue !== 'ok') return;
    const form = dlg.querySelector('form');
    if (!form) return;
    session._dialogResult = JSON.stringify(Object.fromEntries(new FormData(form).entries()));
  });
}

function takeDialogResult(session) {
  const raw = session._dialogResult;
  session._dialogResult = null;
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/* ---------- 汎用フィールド描画 ---------- */

function selectOptions(list, current) {
  return list.map(([k, l]) =>
    `<option value="${ESC(k)}"${k === current ? ' selected' : ''}>${ESC(l)}</option>`).join('');
}

function datalistOptions(list) {
  return list.map(([k, l]) => `<option value="${ESC(k)}">${ESC(l)}</option>`).join('');
}

/* ============================================================
   ジャンルライブラリ
   ============================================================ */

export function mountGenreLibrary(root, client) {
  const session = createSession(root, client, renderLibrary);
  session.cleanups.push(client.subscribe(state => { session.state = state; session.render(); }));
  session.cleanups.push(client.addFlusher(() => flushSession(session), () => session.pending.size > 0 || [...session.dialogs].some(dialog => dialog.open)));

  listen(session, root, 'click', event => { onLibraryClick(session, event); });
  listen(session, root, 'input', event => { onLibraryInput(session, event); });
  listen(session, root, 'change', event => { onLibraryChange(session, event); });
  listen(session, root, 'keydown', event => { onLibraryKeydown(session, event); });
  // フォームの暗黙送信（Enter）でページ遷移しないよう止める。実処理は action/dispatch 側。
  listen(session, root, 'submit', event => { event.preventDefault(); });

  session.render();
  return () => cleanup(session);
}

async function cleanup(session) {
  await flushSession(session);
  session.mounted = false;
  session.listeners.forEach(off => off());
  session.cleanups.forEach(off => off());
  session.pending.forEach(item => clearTimeout(item.timer));
}

/* ---------- ライブラリ描画 ---------- */

function genreOf(session, id) {
  return (session.state?.genres ?? []).find(g => g.id === id) ?? null;
}
function activeGenre(session) {
  return genreOf(session, session.state?.activeGenreId);
}
function pendingCandidateCount(genre) {
  const candidates = genre?.knowledge?.candidates;
  if (Array.isArray(candidates)) return candidates.filter(c => c.status === 'pending').length;
  return genre?.candidateKnowledgeCount ?? 0;
}

function renderLibrary(session) {
  const state = session.state;
  const genres = state?.genres ?? [];
  const activeId = state?.activeGenreId ?? null;
  const genre = genres.find(g => g.id === activeId) ?? null;
  const sel = genre?.selection ?? {};
  const tab = sel.tab || 'overview';

  const items = genres.map(g => `
    <li class="gl-genre-item${g.id === activeId ? ' is-active' : ''}">
      <button type="button" class="gl-genre-name" data-action="select" data-id="${esc(session, g.id)}"
        aria-current="${g.id === activeId ? 'true' : 'false'}"
        title="${esc(session, g.description || g.name || '（無題）')}">
        ${esc(session, g.name || '（無題）')}
      </button>
      <span class="gl-genre-meta muted">資料 ${fmtNum(g.sources?.length ?? g.sourceCount)}・知識 ${fmtNum(g.knowledge?.items?.length ?? g.acceptedKnowledgeCount)}・候補 ${fmtNum(pendingCandidateCount(g))}・会話 ${fmtNum(g.chat?.threads?.length ?? g.chatThreadCount)}</span>
      <span class="gl-genre-actions">
        <button type="button" class="btn-icon" data-action="rename" data-id="${esc(session, g.id)}" title="ジャンル名を変更" aria-label="${esc(session, g.name || '無題')} の名前を変更">✎</button>
        <button type="button" class="btn-icon gl-icon-danger" data-action="delete" data-id="${esc(session, g.id)}" title="ジャンルを削除" aria-label="${esc(session, g.name || '無題')} を削除">×</button>
      </span>
    </li>`).join('');

  const tabs = [
    ['overview', '概要'],
    ['sources', '資料'],
    ['analysis', '分析'],
    ['knowledge', '知識・候補'],
  ].map(([id, name]) => `
    <button type="button" role="tab" id="gl-tab-${id}" aria-selected="${tab === id}"
      data-action="tab" data-tab="${id}"${genre ? '' : ' disabled'}>${name}</button>`).join('');

  const content = genre ? renderTab(session, genre, tab) : `
    <div class="gl-empty gl-empty-large">
      <p>ジャンルを選択するか、新規作成してください。</p>
      <p class="muted">左の一覧から選ぶと、概要・資料・分析・知識を管理できます。</p>
    </div>`;

  return `
    <div class="gl-shell">
      <aside class="gl-sidebar" aria-label="ジャンル一覧">
        <div class="gl-sidebar-head">
          <h2>ジャンル <span class="muted" data-genre-count>${genres.length}</span></h2>
          <button type="button" class="btn btn-small" data-action="new-genre" data-busy-key="genre-new">＋ 新規作成</button>
        </div>
        <ul class="gl-genre-list" data-scroll-key="genre-list" role="list">
          ${items || '<li class="gl-empty muted">ジャンルがまだありません。「＋ 新規作成」から始めてください。</li>'}
        </ul>
        <p class="gl-sidebar-note muted">画面案専用データ・実アプリとは別</p>
      </aside>
      <section class="gl-main" aria-labelledby="gl-tab-${tab}">
        <div class="gl-toolbar">
          <h1 class="gl-heading">${genre ? `ジャンルライブラリ / ${esc(session, genre.name || '（無題）')}` : 'ジャンルライブラリ'}</h1>
          <div class="gl-toolbar-actions">
            <button type="button" class="btn btn-small" data-action="import-source"${genre ? '' : ' disabled'}>＋ 資料を追加</button>
            <button type="button" class="btn btn-small" data-action="open-chat"${genre ? '' : ' disabled'}
              title="このジャンル専用の会話パネルを別窓で開きます">ジャンル会話を開く</button>
          </div>
        </div>
        <div class="gl-tabs" role="tablist" aria-label="ジャンル管理タブ">${tabs}</div>
        <p class="gl-feedback" data-feedback role="status" aria-live="polite" hidden></p>
        <div class="gl-content" data-scroll-key="content:${esc(session, genre?.id ?? 'none')}:${tab}">
          ${content}
        </div>
      </section>
    </div>`;
}

function renderTab(session, genre, tab) {
  switch (tab) {
    case 'sources': return renderSources(session, genre);
    case 'analysis': return renderAnalysis(session, genre);
    case 'knowledge': return renderKnowledge(session, genre);
    default: return renderOverview(session, genre);
  }
}

/* ---- 概要タブ ---- */

function pendingValue(session, key, field, fallback) {
  const item = session.pending.get(key);
  if (item && Object.prototype.hasOwnProperty.call(item.merge, field)) return item.merge[field];
  return fallback ?? '';
}

function renderOverview(session, genre) {
  const key = `genre:${genre.id}`;
  const raw = (field, fallback) => pendingValue(session, key, field, fallback);
  // 配列は「カンマ区切り表示」へ戻す
  const v = (field, fallback) => {
    const value = raw(field, fallback);
    return Array.isArray(value) ? value.join(', ') : value;
  };
  const f = (field, labelText, value, multiline) => {
    const control = multiline
      ? `<textarea data-autosave="genre" data-field="${field}" data-genre-id="${esc(session, genre.id)}"
          data-focus-key="genre:${esc(session, genre.id)}:${field}" rows="4">${esc(session, value)}</textarea>`
      : `<input class="input" data-autosave="genre" data-field="${field}" data-genre-id="${esc(session, genre.id)}"
          data-focus-key="genre:${esc(session, genre.id)}:${field}" value="${esc(session, value)}">`;
    return `<label class="field gl-field"><span class="gl-field-label">${labelText}</span>${control}</label>`;
  };
  return `
    <form class="gl-form" data-form="genre-overview" data-genre-id="${esc(session, genre.id)}">
      <div class="gl-form-head">
        <h3>概要メタデータ</h3>
        <span class="gl-save" data-save-state="${esc(session, key)}" aria-live="polite"></span>
      </div>
      <p class="gl-authority-line"><span class="gl-auth gl-auth-user">ユーザー定義</span> この欄の内容はユーザーが直接編集する定義です。</p>
      ${f('name', 'ジャンル名', v('name', genre.name), false)}
      ${f('aliases', '別名（カンマ区切り）', v('aliases', (genre.aliases ?? []).join(', ')), false)}
      ${f('description', '説明', v('description', genre.description), true)}
      ${f('userDefinition', 'ユーザー定義', v('userDefinition', genre.userDefinition), true)}
      ${f('notes', '補足メモ', v('notes', genre.notes), true)}
      ${f('tags', 'タグ（カンマ区切り）', v('tags', (genre.tags ?? []).join(', ')), false)}
      <dl class="gl-meta">
        <div><dt>状態</dt><dd>${esc(session, label(GENRE_STATUS, genre.status))}</dd></div>
        <div><dt>改訂番号</dt><dd>${fmtNum(genre.revision)}</dd></div>
        <div><dt>作成日時</dt><dd>${esc(session, fmtDate(genre.createdAt))}</dd></div>
        <div><dt>更新日時</dt><dd>${esc(session, fmtDate(genre.updatedAt))}</dd></div>
      </dl>
      <p class="gl-field-note muted">入力は自動保存されます（入力停止時・フォーカス移動時に確定）。</p>
    </form>`;
}

/* ---- 資料タブ ---- */

function renderSources(session, genre) {
  const sources = genre.sources ?? [];
  const selId = genre.selection?.sourceId ?? '';
  const cards = sources.map(s => {
    const selected = s.id === selId;
    return `
      <article class="gl-card gl-source${selected ? ' is-selected' : ''}" data-source-id="${esc(session, s.id)}">
        <header class="gl-card-head">
          <button type="button" class="gl-source-title" data-action="choose-source" data-id="${esc(session, s.id)}"
            title="分析対象として選択し、分析タブを開きます">${esc(session, s.title || '（無題）')}</button>
          ${selected ? '<span class="gl-auth gl-auth-target">分析対象</span>' : ''}
          <span class="gl-auth gl-auth-source">原資料</span>
        </header>
        <p class="gl-meta-line muted">
          ${esc(session, label(SOURCE_ROLES, s.sourceRole))}・${esc(session, label(SOURCE_TYPES, s.sourceType))}・
          ${esc(session, label(PREFERENCES, s.preference))}・${fmtNum(s.characterCount)}文字・
          ${fmtNum(s.segments?.length ?? s.segmentCount)}セグメント・分析状態: ${esc(session, label(ANALYSIS_STATUS, s.analysisStatus))}
        </p>
        ${s.author ? `<p class="gl-meta-line muted">著者: ${esc(session, s.author)}</p>` : ''}
        ${s.userInterpretation ? `<p class="gl-note"><span class="muted">ユーザー解釈:</span> ${esc(session, s.userInterpretation)}</p>` : ''}
        ${s.sourceNote ? `<p class="gl-note"><span class="muted">資料メモ:</span> ${esc(session, s.sourceNote)}</p>` : ''}
        <div class="gl-actions">
          <button type="button" class="btn btn-small" data-action="view-source" data-id="${esc(session, s.id)}">本文を見る</button>
          <button type="button" class="btn btn-small" data-action="edit-source" data-id="${esc(session, s.id)}">メタデータ編集</button>
          <button type="button" class="btn btn-small" data-action="choose-source" data-id="${esc(session, s.id)}">分析対象にする</button>
          <button type="button" class="btn btn-small btn-danger-quiet" data-action="delete-source" data-id="${esc(session, s.id)}" data-busy-key="source-del-${esc(session, s.id)}">削除</button>
        </div>
      </article>`;
  }).join('');

  return `
    <section class="gl-panel" aria-label="資料">
      <div class="gl-panel-head">
        <h3>資料 <span class="muted">${sources.length}</span></h3>
        <button type="button" class="btn btn-small" data-action="import-source">＋ 資料を追加</button>
      </div>
      <p class="gl-authority-line"><span class="gl-auth gl-auth-source">原資料</span> ユーザーが登録した一次資料。AI候補・採用済み知識とは権限が異なります。</p>
      <div class="gl-card-list">
        ${cards || '<p class="gl-empty muted">資料がまだありません。「＋ 資料を追加」でテキストを取り込んでください。</p>'}
      </div>
    </section>`;
}

/* ---- 分析タブ ---- */

function renderAnalysis(session, genre) {
  const sources = genre.sources ?? [];
  if (sources.length === 0) {
    return `
      <section class="gl-panel">
        <p class="gl-empty">分析する資料がありません。まず「＋ 資料を追加」で資料を取り込んでください。</p>
      </section>`;
  }
  const analyses = genre.analyses ?? [];
  const selected = sources.find(s => s.id === genre.selection?.sourceId) ?? sources[0];
  const sourceAnalyses = analyses.filter(a => a.sourceId === selected.id);
  const currentId = genre.selection?.analysisId ?? '';
  const shown = currentId
    ? sourceAnalyses.filter(a => a.id === currentId)
    : sourceAnalyses.slice(0, 1);
  const older = currentId ? sourceAnalyses.filter(a => a.id !== currentId) : sourceAnalyses.slice(1);
  const segs = selected.segments ?? [];

  const segPreview = segs.slice(0, 4).map(seg => `
    <li><span class="muted">${fmtNum((seg.ordinal ?? 0) + 1)}.</span> ${esc(session, seg.heading || '（見出しなし）')}
      <span class="muted">… ${esc(session, sliceSegment(selected.content, seg.startOffset, seg.endOffset).trim().slice(0, 60))}</span></li>`).join('');

  const analysisCards = shown.map(a => renderAnalysisCard(session, selected, a)).join('');
  const moreCards = older.map(a => renderAnalysisCard(session, selected, a, true)).join('');

  return `
    <section class="gl-panel" aria-label="分析">
      <div class="gl-panel-head gl-panel-head-wrap">
        <h3>分析</h3>
        <label class="gl-inline-field">分析対象
          <select class="input" data-change="analysis-target" aria-label="分析対象の資料">
            ${sources.map(s => `<option value="${esc(session, s.id)}"${s.id === selected.id ? ' selected' : ''}>${esc(session, s.title || '（無題）')}</option>`).join('')}
          </select>
        </label>
        ${sourceAnalyses.length > 1 ? `
          <label class="gl-inline-field">表示する結果
            <select class="input" data-change="analysis-pick" aria-label="表示する分析結果">
              <option value="">最新</option>
              ${sourceAnalyses.map(a => `<option value="${esc(session, a.id)}"${a.id === currentId ? ' selected' : ''}>${esc(session, fmtDate(a.createdAt))}${a.isExample ? '（表示例）' : ''}</option>`).join('')}
            </select>
          </label>` : ''}
      </div>
      <p class="gl-authority-line"><span class="gl-auth gl-auth-example">表示例</span> AI分析は画面案では未接続です。結果・進行・失敗の表示は見本です。</p>

      <article class="gl-card">
        <header class="gl-card-head">
          <h4>${esc(session, selected.title || '（無題）')}</h4>
          <span class="gl-auth gl-auth-source">原資料</span>
        </header>
        <p class="gl-meta-line muted">
          ${esc(session, label(SOURCE_ROLES, selected.sourceRole))}・${fmtNum(selected.characterCount)}文字・
          ${segs.length}セグメント・分析状態: ${esc(session, label(ANALYSIS_STATUS, selected.analysisStatus))}
        </p>
        ${segs.length ? `<ul class="gl-seg-preview">${segPreview}</ul>` : ''}
        <div class="gl-actions">
          <button type="button" class="btn" data-action="analyze" data-id="${esc(session, selected.id)}"
            title="画面案ではAI未接続のため実行されません。本来の送信内容を表示します。">この資料を分析（AI未接続）</button>
        </div>
        <p class="gl-analysis-status muted" data-analysis-status>AI分析は画面案では実行されません。</p>
      </article>

      <div class="gl-subhead"><h4>取得済みの分析結果</h4></div>
      ${analysisCards || '<p class="gl-empty muted">この資料の分析結果はまだありません。実アプリでは「この資料を分析」の実行後にここへ保存されます。</p>'}
      ${moreCards ? `<details class="gl-more"><summary>その他の分析結果（${older.length}件）</summary>${moreCards}</details>` : ''}

      <details class="gl-more gl-mock-wrap">
        <summary>進行・失敗時のデザイン見本</summary>
        <p class="muted">実際の実行ではありません。接続時の表示確認用です。</p>
        <div class="gl-mock" aria-label="表示例 — 進行中">
          <span class="gl-auth gl-auth-example">表示例 — 進行中</span>
          <div class="gl-progress" role="progressbar" aria-valuemin="0" aria-valuemax="8" aria-valuenow="5" aria-label="セグメント分析中（表示例）">
            <div class="gl-progress-bar" style="width:62%"></div>
          </div>
          <p class="muted">セグメント分析中 (5/8)…　<button type="button" class="btn btn-small" disabled>キャンセル（見本）</button></p>
        </div>
        <div class="gl-mock" aria-label="表示例 — 一部失敗">
          <span class="gl-auth gl-auth-example">表示例 — 一部失敗</span>
          <p>セグメント分析中 (7/8, 失敗 1)…</p>
          <p class="design-warning">セグメント 3 の分析に失敗しました。他のセグメントは継続します。</p>
        </div>
        <div class="gl-mock" aria-label="表示例 — 失敗">
          <span class="gl-auth gl-auth-example">表示例 — 失敗</span>
          <p class="design-warning">分析に失敗しました：プロバイダから応答がありません（表示例）。</p>
          <p><button type="button" class="btn btn-small" disabled>再試行（見本）</button></p>
        </div>
      </details>
    </section>`;
}

function renderAnalysisCard(session, source, analysis, dimmed = false) {
  const segs = source.segments ?? [];
  const byId = new Map(segs.map(s => [s.id, s]));
  const rows = (analysis.segments ?? []).map(seg => {
    const meta = byId.get(seg.segmentId);
    const head = meta ? `${fmtNum((meta.ordinal ?? 0) + 1)}. ${meta.heading || '（見出しなし）'}` : (seg.segmentId || '—');
    return `<li><span class="gl-seg-head">${esc(session, head)}</span><p class="gl-seg-body">${esc(session, seg.content)}</p></li>`;
  }).join('');
  return `
    <article class="gl-card gl-analysis${dimmed ? ' is-dimmed' : ''}">
      <header class="gl-card-head">
        <h4>${esc(session, fmtDate(analysis.createdAt))} の分析 <span class="muted">状態: ${esc(session, label(ANALYSIS_STATUS, analysis.status))}</span></h4>
        ${analysis.isExample ? '<span class="gl-auth gl-auth-example">表示例（実AIの出力ではありません）</span>' : '<span class="gl-auth gl-auth-ai">AI結果</span>'}
      </header>
      ${analysis.summary ? `<p class="gl-note"><span class="muted">要約:</span> ${esc(session, analysis.summary)}</p>` : ''}
      ${rows ? `<ul class="gl-seg-results">${rows}</ul>` : '<p class="muted">セグメント結果はありません。</p>'}
    </article>`;
}

/* ---- 知識タブ ---- */

function renderKnowledge(session, genre) {
  const knowledge = genre.knowledge ?? { items: [], candidates: [] };
  const candidates = knowledge.candidates ?? [];
  const items = knowledge.items ?? [];
  const sourceById = new Map((genre.sources ?? []).map(s => [s.id, s]));

  const groups = [
    ['pending', '未確認候補'],
    ['on_hold', '保留中'],
    ['rejected', '却下'],
  ].map(([status, heading]) => {
    const list = candidates.filter(c => c.status === status);
    if (!list.length) return '';
    const cards = list.map(c => renderCandidate(session, c, sourceById)).join('');
    return `
      <section class="gl-knowledge-group" aria-label="${esc(session, heading)}">
        <h4>${heading} <span class="muted">${list.length}</span></h4>
        ${cards}
      </section>`;
  }).join('');

  const itemCards = items.map(item => renderKnowledgeItem(session, item, sourceById)).join('');

  return `
    <section class="gl-panel" aria-label="知識と候補">
      <div class="gl-panel-head">
        <h3>知識</h3>
        <button type="button" class="btn btn-small" data-action="create-knowledge">＋ 手動で知識を追加</button>
      </div>
      <p class="gl-authority-line">
        <span class="gl-auth gl-auth-ai">AI候補</span> は未確定の提案、
        <span class="gl-auth gl-auth-accepted">採用済み</span> はユーザー承認済みの知識、
        <span class="gl-auth gl-auth-source">原資料</span> は根拠の一次資料です。権限を混同しません。
      </p>
      <div class="gl-subhead"><h4>AI候補のレビュー</h4></div>
      ${groups || '<p class="gl-empty muted">レビュー対象の候補はありません。</p>'}
      <div class="gl-subhead"><h4>採用済み知識 <span class="muted">${items.length}</span></h4></div>
      ${itemCards || '<p class="gl-empty muted">採用済みの知識はまだありません。候補を「採用」するか、手動で追加してください。</p>'}
    </section>`;
}

function refList(session, refs, sourceById) {
  if (!refs?.length) return '';
  const items = refs.map(r => `<li>${esc(session, describeRef(r, sourceById))}</li>`).join('');
  return `<ul class="gl-refs">${items}</ul>`;
}

function renderCandidate(session, c, sourceById) {
  const provenance = [
    c.createdBy ? `作成: ${label(AUTHORITIES, c.createdBy)}` : '',
    Number.isFinite(c.confidence) ? `確度 ${fmtConfidence(c.confidence)}` : '',
  ].filter(Boolean).join('・');
  const actions = [];
  if (c.status !== 'accepted') actions.push(`<button type="button" class="btn btn-small" data-action="candidate-status" data-id="${esc(session, c.id)}" data-status="accepted" data-busy-key="cand-${esc(session, c.id)}">採用</button>`);
  if (c.status !== 'on_hold') actions.push(`<button type="button" class="btn btn-small" data-action="candidate-status" data-id="${esc(session, c.id)}" data-status="on_hold" data-busy-key="cand-${esc(session, c.id)}">保留</button>`);
  if (c.status !== 'rejected') actions.push(`<button type="button" class="btn btn-small btn-danger-quiet" data-action="candidate-status" data-id="${esc(session, c.id)}" data-status="rejected" data-busy-key="cand-${esc(session, c.id)}">却下</button>`);
  if (c.status !== 'pending') actions.push(`<button type="button" class="btn btn-small" data-action="candidate-status" data-id="${esc(session, c.id)}" data-status="pending" data-busy-key="cand-${esc(session, c.id)}">未確認に戻す</button>`);
  return `
    <article class="gl-card gl-candidate is-${esc(session, c.status)}">
      <header class="gl-card-head">
        <span class="gl-cat">${esc(session, label(CATEGORIES, c.category))}</span>
        <h4>${esc(session, c.title || '（無題）')}</h4>
        <span class="gl-imp">${esc(session, label(IMPORTANCE, c.proposedImportance))}</span>
        <span class="gl-auth gl-auth-ai">AI候補</span>
      </header>
      <p class="gl-statement">${esc(session, c.statement)}</p>
      ${c.explanation ? `<p class="gl-note muted">${esc(session, c.explanation)}</p>` : ''}
      ${provenance ? `<p class="gl-meta-line muted">${esc(session, provenance)}</p>` : ''}
      ${c.sourceReferences?.length ? `<p class="gl-meta-line muted">根拠資料:</p>${refList(session, c.sourceReferences, sourceById)}` : ''}
      ${c.chatReferences?.length ? `<p class="gl-meta-line muted">根拠会話:</p>${refList(session, c.chatReferences, sourceById)}` : ''}
      <div class="gl-actions">${actions.join('')}</div>
    </article>`;
}

function renderKnowledgeItem(session, item, sourceById) {
  const disabled = item.status === 'disabled';
  const next = disabled ? 'active' : 'disabled';
  const provenance = item.createdFromCandidateId
    ? '<span class="gl-auth gl-auth-accepted" title="AI候補をユーザーが採用">採用済み（候補から）</span>'
    : `<span class="gl-auth gl-auth-user">${esc(session, label(AUTHORITIES, item.authority || 'user'))}</span>`;
  return `
    <article class="gl-card gl-item${disabled ? ' is-disabled' : ''}">
      <header class="gl-card-head">
        <span class="gl-cat">${esc(session, label(CATEGORIES, item.category))}</span>
        <h4>${esc(session, item.title || '（無題）')}</h4>
        <span class="gl-imp">${esc(session, label(IMPORTANCE, item.importance))}</span>
        ${provenance}
        ${disabled ? '<span class="gl-auth gl-auth-disabled">無効</span>' : '<span class="gl-auth gl-auth-active">有効</span>'}
      </header>
      <p class="gl-statement">${esc(session, item.statement)}</p>
      ${item.explanation ? `<p class="gl-note muted">${esc(session, item.explanation)}</p>` : ''}
      ${item.sourceReferences?.length ? `<p class="gl-meta-line muted">根拠資料:</p>${refList(session, item.sourceReferences, sourceById)}` : ''}
      ${item.chatReferences?.length ? `<p class="gl-meta-line muted">根拠会話:</p>${refList(session, item.chatReferences, sourceById)}` : ''}
      <div class="gl-actions">
        <button type="button" class="btn btn-small" data-action="edit-knowledge" data-id="${esc(session, item.id)}">編集</button>
        <button type="button" class="btn btn-small" data-action="toggle-knowledge" data-id="${esc(session, item.id)}" data-status="${next}" data-busy-key="kn-${esc(session, item.id)}">${disabled ? '再有効化' : '無効化'}</button>
        <button type="button" class="btn btn-small btn-danger-quiet" data-action="delete-knowledge" data-id="${esc(session, item.id)}" data-busy-key="knd-${esc(session, item.id)}">削除</button>
      </div>
    </article>`;
}

/* ---------- ライブラリのイベント ---------- */

function onLibraryInput(session, event) {
  const el = event.target;
  if (el?.dataset?.autosave !== 'genre') return;
  const genreId = el.dataset.genreId;
  const field = el.dataset.field;
  if (!genreId || !field) return;
  const raw = el.value;
  const value = (field === 'aliases' || field === 'tags') ? splitList(raw) : raw;
  schedule(session, `genre:${genreId}`, 'genre', { [field]: value }, { genreId, field },
    async changes => {
      const genre = genreOf(session, genreId);
      if (!genre) return;
      await session.client.dispatch('genre.update', {
        genreId,
        changes,
        expectedRevision: genre.revision,
      });
    },
    () => !!genreOf(session, genreId));
}

function onLibraryChange(session, event) {
  const el = event.target;
  if (!el?.dataset) return;
  if (el.dataset.autosave === 'genre') {
    drainKey(session, `genre:${el.dataset.genreId}`);
    return;
  }
  const genre = activeGenre(session);
  if (!genre) return;
  if (el.dataset.change === 'analysis-target') {
    session.client.dispatch('genre.selection', { genreId: genre.id, changes: { sourceId: el.value } })
      .catch(error => reportError(session, error));
  } else if (el.dataset.change === 'analysis-pick') {
    session.client.dispatch('genre.selection', { genreId: genre.id, changes: { analysisId: el.value } })
      .catch(error => reportError(session, error));
  }
}

function onLibraryKeydown(session, event) {
  const tab = event.target?.closest?.('[role="tab"]');
  if (!tab) return;
  const list = [...session.root.querySelectorAll('[role="tab"]')].filter(b => !b.disabled);
  const index = list.indexOf(tab);
  if (index < 0) return;
  let next = null;
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = list[(index + 1) % list.length];
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = list[(index - 1 + list.length) % list.length];
  else if (event.key === 'Home') next = list[0];
  else if (event.key === 'End') next = list[list.length - 1];
  if (next) {
    event.preventDefault();
    next.focus();
    next.click();
  }
}

function onLibraryClick(session, event) {
  const el = event.target.closest?.('[data-action]');
  if (!el || !session.root.contains(el)) return;
  const action = el.dataset.action;
  const id = el.dataset.id;
  const genre = activeGenre(session);

  switch (action) {
    case 'new-genre':
      run(session, 'genre-new', async () => {
        const name = await promptDialog(session, { title: '新しいジャンル', label: 'ジャンル名', value: '', okLabel: '作成' });
        if (name == null) return;
        await session.client.dispatch('genre.create', { values: { name: name.trim() || '新規ジャンル' } });
        // genre.create が activeGenreId を新規項目へ切り替える（design-model 準拠）
        setFeedback(session, 'ジャンルを作成しました。', 'ok');
      });
      break;
    case 'select':
      if (id) run(session, `sel-${id}`, async () => {
        await drainAll(session);
        await session.client.dispatch('genre.select', { genreId: id });
      });
      break;
    case 'rename': {
      const g = genreOf(session, id);
      if (!g) break;
      run(session, `ren-${id}`, async () => {
        const name = await promptDialog(session, { title: 'ジャンル名を変更', label: 'ジャンル名', value: g.name || '', okLabel: '変更' });
        if (name == null) return;
        await session.client.dispatch('genre.update', { genreId: id, changes: { name }, expectedRevision: g.revision });
      });
      break;
    }
    case 'delete': {
      const g = genreOf(session, id);
      if (!g) break;
      run(session, `del-${id}`, async () => {
        const ok = await confirmDialog(session, {
          title: 'ジャンルの削除',
          body: `「${esc(session, g.name || '（無題）')}」と関連する資料・知識・会話をすべて削除しますか？この操作は元に戻せません。`,
          okLabel: '削除する',
        });
        if (!ok) return;
        await session.client.dispatch('genre.delete', { genreId: id });
        dropPending(session, `genre:${id}`);
        setFeedback(session, 'ジャンルを削除しました。', 'ok');
      });
      break;
    }
    case 'tab':
      if (!genre) break;
      run(session, `tab-${el.dataset.tab}`, async () => {
        await drainAll(session);
        await session.client.dispatch('genre.selection', { genreId: genre.id, changes: { tab: el.dataset.tab } });
      });
      break;
    case 'import-source':
      if (!genre) break;
      run(session, 'src-add', () => sourceFormDialog(session, genre, null));
      break;
    case 'edit-source': {
      const s = genre?.sources?.find(x => x.id === id);
      if (!s) break;
      run(session, `src-edit-${id}`, () => sourceFormDialog(session, genre, s));
      break;
    }
    case 'view-source': {
      const s = genre?.sources?.find(x => x.id === id);
      if (!s) break;
      openSourceReader(session, s);
      break;
    }
    case 'choose-source':
      if (!genre || !id) break;
      run(session, `sel-src-${id}`, async () => {
        await session.client.dispatch('genre.selection', { genreId: genre.id, changes: { sourceId: id, tab: 'analysis' } });
      });
      break;
    case 'delete-source':
      run(session, `source-del-${id}`, async () => {
        const s = genre?.sources?.find(x => x.id === id);
        if (!s || !genre) return;
        const ok = await confirmDialog(session, {
          title: '資料の削除',
          body: `「${esc(session, s.title || '（無題）')}」を削除しますか？紐づくセグメントと分析結果も失われます。`,
          okLabel: '削除する',
        });
        if (!ok) return;
        await session.client.dispatch('source.delete', { genreId: genre.id, id });
        setFeedback(session, '資料を削除しました。', 'ok');
      });
      break;
    case 'analyze': {
      const s = genre?.sources?.find(x => x.id === id) ?? genre?.sources?.[0];
      const role = session.state?.settings?.roles?.chat ?? {};
      const status = session.root.querySelector('[data-analysis-status]');
      const detail = `対象: 「${s?.title ?? ''}」・${s?.segments?.length ?? 0}セグメント → ${role.provider ?? 'プロバイダ未設定'} / ${role.model ?? 'モデル未設定'}（chatロール）`;
      if (status) status.textContent = `未接続 — 画面案ではAI分析を実行できません。${detail}`;
      setFeedback(session, `AI分析は未接続です（画面案）。実行されず、結果は追加されません。${detail}`, 'info');
      break;
    }
    case 'open-chat':
      if (!genre) break;
      try {
        session.client.openPanel('genre-chat', { genreId: genre.id });
      } catch (error) {
        reportError(session, error);
      }
      drainAll(session);
      break;
    case 'create-knowledge':
      if (!genre) break;
      run(session, 'kn-new', () => knowledgeFormDialog(session, genre, null));
      break;
    case 'edit-knowledge': {
      const item = genre?.knowledge?.items?.find(x => x.id === id);
      if (!item) break;
      run(session, `kn-edit-${id}`, () => knowledgeFormDialog(session, genre, item));
      break;
    }
    case 'toggle-knowledge':
      if (!genre) break;
      run(session, `kn-${id}`, async () => {
        await session.client.dispatch('knowledge.status', { genreId: genre.id, id, status: el.dataset.status });
      });
      break;
    case 'delete-knowledge':
      run(session, `knd-${id}`, async () => {
        const item = genre?.knowledge?.items?.find(x => x.id === id);
        if (!item || !genre) return;
        const ok = await confirmDialog(session, {
          title: '知識の削除',
          body: `「${esc(session, item.title || '（無題）')}」を削除しますか？`,
          okLabel: '削除する',
        });
        if (!ok) return;
        await session.client.dispatch('knowledge.delete', { genreId: genre.id, id });
        setFeedback(session, '知識を削除しました。', 'ok');
      });
      break;
    case 'candidate-status':
      if (!genre) break;
      run(session, `cand-${id}`, async () => {
        await session.client.dispatch('candidate.status', { genreId: genre.id, id, status: el.dataset.status });
        setFeedback(session, `候補を${CANDIDATE_STATUS_LABEL[el.dataset.status] ?? '更新しました'}。`, 'ok');
      });
      break;
    default:
      break;
  }
}

/* ---- 資料フォームダイアログ ---- */

function sourceFormFields(session, s = {}) {
  const val = (k, fallback = '') => s[k] ?? fallback;
  return `
    <div class="dlg-body">
      <label class="field"><span class="gl-field-label">タイトル *</span>
        <input class="input" name="title" value="${esc(session, val('title'))}" required autofocus></label>
      <label class="field"><span class="gl-field-label">著者・出典</span>
        <input class="input" name="author" value="${esc(session, val('author'))}"></label>
      <div class="gl-grid2">
        <label class="field"><span class="gl-field-label">種別</span>
          <input class="input" name="sourceType" list="gl-source-types" value="${esc(session, val('sourceType', 'other'))}">
          <datalist id="gl-source-types">${datalistOptions(SOURCE_TYPES)}</datalist></label>
        <label class="field"><span class="gl-field-label">役割</span>
          <select class="input" name="sourceRole">${selectOptions(SOURCE_ROLES, val('sourceRole', 'partial_example'))}</select></label>
        <label class="field"><span class="gl-field-label">参照の向き</span>
          <select class="input" name="preference">${selectOptions(PREFERENCES, val('preference', 'neutral'))}</select></label>
        <label class="field"><span class="gl-field-label">メディア種別</span>
          <select class="input" name="mediaType">${selectOptions(MEDIA_TYPES, val('mediaType', 'text/markdown'))}</select></label>
        <label class="field"><span class="gl-field-label">言語</span>
          <input class="input" name="language" value="${esc(session, val('language', 'ja'))}"></label>
      </div>
      <label class="field"><span class="gl-field-label">資料メモ</span>
        <textarea name="sourceNote" rows="2">${esc(session, val('sourceNote'))}</textarea></label>
      <label class="field"><span class="gl-field-label">ユーザー解釈</span>
        <textarea name="userInterpretation" rows="3" placeholder="この資料をどう読み・どう使うか（ユーザー自身の解釈）">${esc(session, val('userInterpretation'))}</textarea></label>
      ${s.id === undefined ? `
        <label class="field"><span class="gl-field-label">本文 *（取り込み後の直接編集はできません）</span>
          <textarea name="content" rows="10" required placeholder="資料本文を貼り付けてください。自動でセグメント分割されます。"></textarea></label>`
      : '<p class="dlg-note">本文は取り込み時に確定します（セグメント分割・分析との整合のため直接編集できません）。「本文を見る」で参照できます。</p>'}
    </div>`;
}

async function sourceFormDialog(session, genre, source) {
  const isNew = !source;
  const value = await openDialog(session, {
    title: isNew ? '資料を追加' : `資料メタデータ — ${source.title || '（無題）'}`,
    markup: `
      <form method="dialog" class="gl-dialog-form" data-form="source" data-genre-id="${esc(session, genre.id)}" data-source-id="${esc(session, source?.id ?? '')}">
        ${sourceFormFields(session, source ?? {})}
        <footer class="dlg-foot">
          <button type="submit" class="btn btn-primary" value="ok">${isNew ? '追加する' : '保存する'}</button>
          <button type="button" class="btn" data-dlg-cancel>キャンセル</button>
        </footer>
      </form>`,
    prepare(dlg) { captureForm(session, dlg); },
  });
  if (value !== 'ok') return;
  const values = takeDialogResult(session);
  if (!values) return;
  const payload = {
    title: String(values.title ?? '').trim(),
    author: String(values.author ?? '').trim(),
    sourceType: String(values.sourceType ?? 'other').trim() || 'other',
    sourceRole: String(values.sourceRole ?? 'partial_example'),
    preference: String(values.preference ?? 'neutral'),
    mediaType: String(values.mediaType ?? 'text/markdown'),
    language: String(values.language ?? 'ja').trim() || 'ja',
    sourceNote: String(values.sourceNote ?? ''),
    userInterpretation: String(values.userInterpretation ?? ''),
  };
  if (!payload.title) { setFeedback(session, 'タイトルは必須です。', 'error'); return; }
  if (isNew) {
    const content = String(values.content ?? '');
    if (!content.trim()) { setFeedback(session, '本文は必須です。', 'error'); return; }
    const res = await session.client.dispatch('source.create', { genreId: genre.id, values: { ...payload, content } });
    if (res?.id) {
      await session.client.dispatch('genre.selection', { genreId: genre.id, changes: { sourceId: res.id, tab: 'analysis' } });
    }
    setFeedback(session, `資料「${payload.title}」を追加しました。`, 'ok');
  } else {
    await session.client.dispatch('source.update', {
      genreId: genre.id, id: source.id, changes: payload, expectedRevision: source.revision,
    });
    setFeedback(session, '資料メタデータを保存しました。', 'ok');
  }
}

/* ---- 資料リーダー（本文参照 + セグメント表示） ---- */

function openSourceReader(session, source) {
  const segs = source.segments ?? [];
  const content = String(source.content ?? '');
  const block = (heading, text, cls = '') =>
    `<section class="gl-read-seg${cls}"><h5>${esc(session, heading)}</h5><pre class="gl-read-text">${esc(session, text)}</pre></section>`;
  let body;
  if (segs.length) {
    const parts = [];
    const sorted = [...segs].sort((a, b) => (a.startOffset ?? 0) - (b.startOffset ?? 0));
    const first = Math.min(...sorted.map(s => Number(s.startOffset) || 0));
    if (first > 0) parts.push(block('（先頭 — セグメント外）', sliceSegment(content, 0, first), ' is-gap'));
    sorted.forEach((seg, i) => {
      const prevEnd = i === 0 ? first : (sorted[i - 1].endOffset ?? 0);
      if ((seg.startOffset ?? 0) > prevEnd) {
        parts.push(block('（セグメント間）', sliceSegment(content, prevEnd, seg.startOffset), ' is-gap'));
      }
      parts.push(block(`セグメント ${fmtNum((seg.ordinal ?? i) + 1)} — ${seg.heading || '（見出しなし）'}`, sliceSegment(content, seg.startOffset, seg.endOffset)));
    });
    const lastEnd = Math.max(...sorted.map(s => Number(s.endOffset) || 0));
    const totalLen = content.length;
    if (lastEnd < totalLen) parts.push(block('（末尾 — セグメント外）', sliceSegment(content, lastEnd, totalLen), ' is-gap'));
    body = parts.join('');
  } else {
    body = block('全文（セグメントなし）', content);
  }
  openDialog(session, {
    title: `資料 — ${source.title || '（無題）'}`,
    markup: `
      <div class="dlg-body gl-read-body">
        <p class="gl-meta-line muted">
          ${esc(session, label(SOURCE_ROLES, source.sourceRole))}・${esc(session, label(SOURCE_TYPES, source.sourceType))}・
          ${fmtNum(source.characterCount)}文字・${segs.length}セグメント・${esc(session, label(ANALYSIS_STATUS, source.analysisStatus))}
        </p>
        ${source.author ? `<p class="gl-meta-line muted">著者: ${esc(session, source.author)}</p>` : ''}
        ${source.sourceNote ? `<p class="gl-note"><span class="muted">資料メモ:</span> ${esc(session, source.sourceNote)}</p>` : ''}
        ${source.userInterpretation ? `<p class="gl-note"><span class="muted">ユーザー解釈:</span> ${esc(session, source.userInterpretation)}</p>` : ''}
        <div class="gl-read-scroll">${body}</div>
      </div>
      <footer class="dlg-foot"><button type="button" class="btn" data-dlg-cancel>閉じる</button></footer>`,
  });
}

/* ---- 知識フォームダイアログ ---- */

async function knowledgeFormDialog(session, genre, item) {
  const isNew = !item;
  const cur = item ?? {};
  const value = await openDialog(session, {
    title: isNew ? '知識を追加' : `知識を編集 — ${cur.title || '（無題）'}`,
    markup: `
      <form method="dialog" class="gl-dialog-form" data-form="knowledge" data-genre-id="${esc(session, genre.id)}" data-knowledge-id="${esc(session, item?.id ?? '')}">
        <div class="dlg-body">
          <label class="field"><span class="gl-field-label">タイトル *</span>
            <input class="input" name="title" value="${esc(session, cur.title ?? '')}" required autofocus></label>
          <label class="field"><span class="gl-field-label">ステートメント（ルール本文）*</span>
            <textarea name="statement" rows="3" required placeholder="生成・評価に直接使える具体的な基準文">${esc(session, cur.statement ?? '')}</textarea></label>
          <div class="gl-grid2">
            <label class="field"><span class="gl-field-label">カテゴリ</span>
              <select class="input" name="category">${selectOptions(CATEGORIES, cur.category ?? 'definition')}</select></label>
            <label class="field"><span class="gl-field-label">重要度</span>
              <select class="input" name="importance">${selectOptions(IMPORTANCE, cur.importance ?? 'optional')}</select></label>
          </div>
          <label class="field"><span class="gl-field-label">説明（根拠・使いどころ）</span>
            <textarea name="explanation" rows="3">${esc(session, cur.explanation ?? '')}</textarea></label>
        </div>
        <footer class="dlg-foot">
          <button type="submit" class="btn btn-primary" value="ok">${isNew ? '追加する' : '保存する'}</button>
          <button type="button" class="btn" data-dlg-cancel>キャンセル</button>
        </footer>
      </form>`,
    prepare(dlg) { captureForm(session, dlg); },
  });
  if (value !== 'ok') return;
  const values = takeDialogResult(session);
  if (!values) return;
  const payload = {
    title: String(values.title ?? '').trim(),
    statement: String(values.statement ?? '').trim(),
    category: String(values.category ?? 'definition'),
    importance: String(values.importance ?? 'optional'),
    explanation: String(values.explanation ?? ''),
  };
  if (!payload.title || !payload.statement) { setFeedback(session, 'タイトルとステートメントは必須です。', 'error'); return; }
  if (isNew) {
    await session.client.dispatch('knowledge.create', {
      genreId: genre.id,
      values: { ...payload, status: 'active', authority: 'user' },
    });
    setFeedback(session, `知識「${payload.title}」を追加しました。`, 'ok');
  } else {
    await session.client.dispatch('knowledge.update', {
      genreId: genre.id, id: item.id, changes: payload, expectedRevision: item.revision,
    });
    setFeedback(session, '知識を保存しました。', 'ok');
  }
}

/* ============================================================
   ジャンルチャット（分離パネル）
   ============================================================ */

export function mountGenreChat(root, client, genreId) {
  const session = createSession(root, client, renderChat);
  session.genreId = genreId || null;
  session.afterRender = pinChatScroll;
  session.cleanups.push(client.subscribe(state => { session.state = state; session.render(); }));
  session.cleanups.push(client.addFlusher(() => flushSession(session), () => session.pending.size > 0 || [...session.dialogs].some(dialog => dialog.open)));

  listen(session, root, 'click', event => { onChatClick(session, event); });
  listen(session, root, 'input', event => { onChatInput(session, event); });
  listen(session, root, 'change', event => { onChatChange(session, event); });
  listen(session, root, 'keydown', event => { onChatKeydown(session, event); });
  // フォームの暗黙送信（Enter）でページ遷移しないよう止める。
  listen(session, root, 'submit', event => { event.preventDefault(); });

  session.render();
  return () => cleanup(session);
}

function chatGenre(session) {
  return genreOf(session, session.genreId || session.state?.activeGenreId);
}
function activeThread(session, genre) {
  const threads = genre?.chat?.threads ?? [];
  return threads.find(t => t.id === genre?.chat?.activeThreadId) ?? null;
}
function inputKey(gid, tid) {
  return `gc-input:${gid}:${tid}`;
}

// スレッド切替・新着メッセージ時のみ末尾へ（入力中の再描画では動かない）
function pinChatScroll(session) {
  const genre = chatGenre(session);
  const thread = activeThread(session, genre);
  const messages = thread?.messages ?? [];
  const sig = `${thread?.id ?? ''}:${messages.length}:${messages[messages.length - 1]?.id ?? ''}`;
  const box = session.root.querySelector('.gc-messages');
  if (box && sig !== session.lastScrollSig) {
    session.lastScrollSig = sig;
    box.scrollTop = box.scrollHeight;
  } else if (sig !== session.lastScrollSig) {
    session.lastScrollSig = sig;
  }
}

function renderChat(session) {
  const genre = chatGenre(session);
  if (!genre) {
    return `
      <div class="gc-panel">
        <header class="gc-header"><h2>ジャンル会話</h2>
          <span class="badge">UIデザイン案・画面案専用データ・実アプリとは別</span></header>
        <p class="gc-feedback" data-feedback role="status" aria-live="polite" hidden></p>
        <p class="gl-empty gl-empty-large">対象のジャンルが見つかりません。ジャンルライブラリから「ジャンル会話を開く」を選んでください。</p>
      </div>`;
  }
  const gid = genre.id;
  const chat = genre.chat ?? { threads: [], activeThreadId: null };
  const threads = chat.threads ?? [];
  const active = activeThread(session, genre);
  const liveThreads = threads.filter(t => t.status !== 'archived');
  const archived = threads.filter(t => t.status === 'archived');

  const threadRow = t => `
    <li class="gc-thread${t.id === active?.id ? ' is-active' : ''}">
      <button type="button" class="gc-thread-name" data-action="select-thread" data-id="${esc(session, t.id)}"
        aria-current="${t.id === active?.id ? 'true' : 'false'}" title="${esc(session, t.summary || t.title || '（無題）')}">
        ${esc(session, t.title || '（無題）')}
        <span class="gc-thread-meta muted">${(t.messages ?? []).length}件${t.status === 'archived' ? '・アーカイブ' : ''}</span>
      </button>
      <span class="gc-thread-actions">
        <button type="button" class="btn-icon" data-action="rename-thread" data-id="${esc(session, t.id)}" title="名前を変更" aria-label="スレッド名を変更">✎</button>
        ${t.status === 'archived'
          ? ''
          : `<button type="button" class="btn-icon" data-action="archive-thread" data-id="${esc(session, t.id)}" title="アーカイブ" aria-label="スレッドをアーカイブ">▤</button>`}
        <button type="button" class="btn-icon gl-icon-danger" data-action="delete-thread" data-id="${esc(session, t.id)}" title="削除" aria-label="スレッドを削除">×</button>
      </span>
    </li>`;

  const messages = active?.messages ?? [];
  const msgHtml = messages.map(m => renderMessage(session, m)).join('');
  const draftAttachments = active?.attachments ?? [];
  const inputValue = active ? pendingValue(session, inputKey(gid, active.id), 'input', active.input ?? '') : '';
  const saveKey = active ? inputKey(gid, active.id) : 'gc-input:none';

  return `
    <div class="gc-panel">
      <header class="gc-header">
        <div class="gc-title-wrap">
          <h2>ジャンル会話 — ${esc(session, genre.name || '（無題）')}</h2>
          <span class="badge" title="AI送信は未接続です。履歴・下書きは画面案専用データです">UIデザイン案・AI未接続・画面案専用データ</span>
        </div>
        <button type="button" class="btn btn-small" data-action="new-thread" data-busy-key="gc-new">＋ 新規スレッド</button>
      </header>
      <p class="gc-feedback" data-feedback role="status" aria-live="polite" hidden></p>

      <nav class="gc-threads" aria-label="会話スレッド">
        <ul data-scroll-key="gc-threads">
          ${liveThreads.map(threadRow).join('') || '<li class="gl-empty muted">スレッドがありません。</li>'}
        </ul>
        ${archived.length ? `
          <details class="gc-archived">
            <summary>アーカイブ済み（${archived.length}）</summary>
            <ul>${archived.map(threadRow).join('')}</ul>
          </details>` : ''}
      </nav>

      <section class="gc-messages-wrap" aria-label="会話履歴">
        ${active?.status === 'archived' ? '<p class="gc-arch-note muted">このスレッドはアーカイブ済みです。</p>' : ''}
        ${messages.some(m => m.isExample) ? '<p class="gc-example-note muted"><span class="gl-auth gl-auth-example">表示例</span> この履歴には見本データが含まれます。実AIの応答ではありません。</p>' : ''}
        <div class="gc-messages" data-scroll-key="gc-messages" role="log" aria-live="polite" aria-label="会話履歴">
          ${msgHtml || (active ? '<p class="gl-empty muted">まだメッセージがありません。</p>' : '<p class="gl-empty muted">スレッドを選択するか、新規作成してください。</p>')}
        </div>
      </section>

      <form class="gc-composer" data-form="gc-composer" data-genre-id="${esc(session, gid)}" data-thread-id="${esc(session, active?.id ?? '')}">
        ${draftAttachments.length ? `
          <ul class="gc-attachments" aria-label="添付（下書き）">
            ${draftAttachments.map(a => `
              <li class="gc-attach">
                <button type="button" class="gc-attach-name" data-action="view-attachment" data-id="${esc(session, a.id)}" title="内容を見る">${esc(session, a.name || '添付')}</button>
                <span class="muted">${esc(session, fmtSize(a.size))}</span>
                <button type="button" class="btn-icon" data-action="delete-attachment" data-id="${esc(session, a.id)}" aria-label="添付を削除">×</button>
              </li>`).join('')}
          </ul>` : ''}
        <label class="design-sr-only" for="gc-input">メッセージ入力</label>
        <textarea id="gc-input" data-autosave="chat" data-focus-key="gc:${esc(session, gid)}:${esc(session, active?.id ?? 'none')}:input"
          placeholder="${active ? 'メッセージを入力…（Ctrl+Enter で送信）' : 'スレッドを選択してください'}"
          ${active ? '' : 'disabled'} rows="3">${esc(session, inputValue)}</textarea>
        <div class="gc-composer-row">
          <span class="gc-save" data-save-state="${esc(session, saveKey)}" aria-live="polite"></span>
          <span class="gc-tools">
            <button type="button" class="btn btn-small" data-action="attach-file"${active ? '' : ' disabled'}>ファイルを添付</button>
            <button type="button" class="btn btn-small" data-action="attach-text"${active ? '' : ' disabled'}>テキストを添付</button>
            <button type="button" class="btn btn-small" data-action="register-source"${active ? '' : ' disabled'}
              title="入力中のテキストをジャンル資料として登録します">資料として登録</button>
            <button type="button" class="btn btn-primary" data-action="send"${active ? '' : ' disabled'}
              title="画面案ではAI未接続のため送信されません">送信 — AI未接続</button>
          </span>
          <input type="file" class="design-sr-only" data-file-input accept=".txt,.md,.markdown,text/plain,text/markdown" aria-hidden="true" tabindex="-1">
        </div>
        <p class="gc-hint muted">Ctrl+Enter で送信（画面案では未接続のため送信されず、入力は保持されます）</p>
      </form>
    </div>`;
}

function renderMessage(session, m) {
  const role = m.role === 'user' ? 'user' : 'assistant';
  const atts = (m.attachments ?? []).map(a => `
    <button type="button" class="gc-attach-chip" data-action="view-msg-attachment" data-message="${esc(session, m.id)}" data-id="${esc(session, a.id)}"
      title="添付の内容を見る">${esc(session, a.name || '添付')} <span class="muted">${esc(session, fmtSize(a.size))}</span></button>`).join('');
  return `
    <article class="gc-msg is-${role}">
      <header class="gc-msg-head">
        <span class="gc-role">${role === 'user' ? 'あなた' : 'AI'}</span>
        ${m.provider || m.model ? `<span class="muted">${esc(session, [m.provider, m.model].filter(Boolean).join(' / '))}</span>` : ''}
        ${m.isExample ? '<span class="gl-auth gl-auth-example">表示例</span>' : ''}
      </header>
      <div class="gc-body">${esc(session, m.content)}</div>
      ${atts ? `<div class="gc-msg-atts">${atts}</div>` : ''}
    </article>`;
}

/* ---------- チャットのイベント ---------- */

function onChatInput(session, event) {
  const el = event.target;
  if (el?.dataset?.autosave !== 'chat') return;
  const genre = chatGenre(session);
  const thread = activeThread(session, genre);
  if (!genre || !thread) return;
  const gid = genre.id;
  const tid = thread.id;
  schedule(session, inputKey(gid, tid), 'chat', { input: el.value }, { genreId: gid, threadId: tid },
    async changes => {
      await session.client.dispatch('chat.update', { genreId: gid, threadId: tid, changes });
    },
    () => {
      const g = chatGenre(session);
      return !!g?.chat?.threads?.some(t => t.id === tid);
    });
}

function onChatChange(session, event) {
  const el = event.target;
  if (!el?.dataset) return;
  if (el.dataset.autosave === 'chat') {
    const genre = chatGenre(session);
    const thread = activeThread(session, genre);
    if (thread) drainKey(session, inputKey(genre.id, thread.id));
    return;
  }
  if (el.dataset.fileInput !== undefined && el.files?.length) {
    attachFiles(session, [...el.files]);
    el.value = '';
  }
}

function onChatKeydown(session, event) {
  const el = event.target;
  if (el?.dataset?.autosave === 'chat' && (event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault();
    attemptSend(session);
  }
}

function onChatClick(session, event) {
  const el = event.target.closest?.('[data-action]');
  if (!el || !session.root.contains(el)) return;
  const genre = chatGenre(session);
  if (!genre) return;
  const gid = genre.id;
  const id = el.dataset.id;
  const thread = activeThread(session, genre);

  switch (el.dataset.action) {
    case 'new-thread':
      run(session, 'gc-new', async () => {
        const title = await promptDialog(session, { title: '新規スレッド', label: 'スレッド名', value: '新規スレッド', okLabel: '作成', required: false });
        if (title == null) return;
        await session.client.dispatch('thread.create', { genreId: gid, title: title.trim() || '新規スレッド' });
        // thread.create が activeThreadId を新規スレッドへ切り替える（design-model 準拠）
      });
      break;
    case 'select-thread':
      if (!id) break;
      run(session, `th-${id}`, async () => {
        await drainAll(session);
        await session.client.dispatch('thread.select', { genreId: gid, id });
      });
      break;
    case 'rename-thread': {
      const t = (genre.chat?.threads ?? []).find(x => x.id === id);
      if (!t) break;
      run(session, `th-r-${id}`, async () => {
        const title = await promptDialog(session, { title: 'スレッド名を変更', label: 'スレッド名', value: t.title || '', okLabel: '変更' });
        if (title == null) return;
        await session.client.dispatch('thread.rename', { genreId: gid, id, title });
      });
      break;
    }
    case 'archive-thread':
      if (!id) break;
      run(session, `th-a-${id}`, async () => {
        const t = (genre.chat?.threads ?? []).find(x => x.id === id);
        const ok = await confirmDialog(session, {
          title: 'スレッドのアーカイブ',
          body: `「${esc(session, t?.title || '（無題）')}」をアーカイブしますか？一覧の「アーカイブ済み」へ移動します。`,
          okLabel: 'アーカイブする',
        });
        if (!ok) return;
        await session.client.dispatch('thread.archive', { genreId: gid, id });
      });
      break;
    case 'delete-thread':
      if (!id) break;
      run(session, `th-d-${id}`, async () => {
        const t = (genre.chat?.threads ?? []).find(x => x.id === id);
        const ok = await confirmDialog(session, {
          title: 'スレッドの削除',
          body: `「${esc(session, t?.title || '（無題）')}」を削除しますか？会話履歴と添付も失われます。`,
          okLabel: '削除する',
        });
        if (!ok) return;
        await session.client.dispatch('thread.delete', { genreId: gid, id });
        dropPending(session, inputKey(gid, id));
      });
      break;
    case 'send':
      attemptSend(session);
      break;
    case 'attach-file': {
      const input = session.root.querySelector('[data-file-input]');
      if (input) input.click();
      break;
    }
    case 'attach-text':
      if (!thread) break;
      run(session, 'att-t', async () => {
        const text = await promptDialog(session, { title: 'テキストを添付', label: '添付するテキスト', value: '', okLabel: '添付', required: true, multiline: true });
        if (text == null) return;
        const name = await promptDialog(session, { title: '添付名', label: '表示名', value: '添付テキスト.txt', okLabel: '添付', required: false });
        await session.client.dispatch('attachment.create', {
          genreId: gid, threadId: thread.id,
          values: {
            name: (name ?? '').trim() || '添付テキスト.txt',
            type: 'text/plain',
            size: new TextEncoder().encode(text).length,
            content: text,
          },
        });
      });
      break;
    case 'delete-attachment':
      if (!thread || !id) break;
      run(session, `att-d-${id}`, async () => {
        const ok = await confirmDialog(session, {
          title: '添付の削除',
          body: 'この添付を下書きから削除しますか？',
          okLabel: '削除する',
        });
        if (!ok) return;
        await session.client.dispatch('attachment.delete', { genreId: gid, threadId: thread.id, id });
      });
      break;
    case 'view-attachment': {
      const a = (thread?.attachments ?? []).find(x => x.id === id);
      if (!a) break;
      openAttachmentViewer(session, a);
      break;
    }
    case 'view-msg-attachment': {
      const msg = (thread?.messages ?? []).find(x => x.id === el.dataset.message);
      const a = (msg?.attachments ?? []).find(x => x.id === id);
      if (!a) break;
      openAttachmentViewer(session, a);
      break;
    }
    case 'register-source':
      if (!thread) break;
      run(session, 'reg-src', async () => {
        const content = String(pendingValue(session, inputKey(gid, thread.id), 'input', thread.input ?? '')).trim();
        if (!content) {
          setFeedback(session, '先に本文を入力してください。入力中のテキストを資料として登録します。', 'error');
          return;
        }
        const title = await promptDialog(session, { title: '資料として登録', label: '資料のタイトル', value: 'チャット資料', okLabel: '登録' });
        if (title == null) return;
        await drainAll(session);
        const res = await session.client.dispatch('source.create', {
          genreId: gid,
          values: {
            title: title.trim() || 'チャット資料',
            content,
            sourceType: 'other',
            sourceRole: 'partial_example',
            preference: 'neutral',
            mediaType: 'text/markdown',
            language: 'ja',
          },
        });
        dropPending(session, inputKey(gid, thread.id));
        await session.client.dispatch('chat.update', { genreId: gid, threadId: thread.id, changes: { input: '' } });
        setFeedback(session, res?.id ? `資料「${title.trim() || 'チャット資料'}」として登録しました。` : '資料として登録しました。', 'ok');
      });
      break;
    default:
      break;
  }
}

function openAttachmentViewer(session, a) {
  openDialog(session, {
    title: `添付 — ${a.name || '添付'}`,
    markup: `
      <div class="dlg-body">
        <p class="gl-meta-line muted">${esc(session, a.type || '不明')}・${esc(session, fmtSize(a.size) || 'サイズ不明')}</p>
        <pre class="gl-read-text">${esc(session, a.content ?? '（内容プレビューはありません）')}</pre>
      </div>
      <footer class="dlg-foot"><button type="button" class="btn" data-dlg-cancel>閉じる</button></footer>`,
  });
}

function attemptSend(session) {
  const genre = chatGenre(session);
  const thread = activeThread(session, genre);
  if (!thread) { setFeedback(session, 'スレッドを選択してください。', 'error'); return; }
  const input = String(pendingValue(session, inputKey(genre.id, thread.id), 'input', thread.input ?? ''));
  const hasAttachments = (thread.attachments ?? []).length > 0;
  if (!input.trim() && !hasAttachments) { setFeedback(session, 'メッセージを入力してください。', 'error'); return; }
  const role = session.state?.settings?.roles?.chat ?? {};
  setFeedback(
    session,
    `未接続 — 画面案ではAIに送信できません。送信は行われず、入力は保持されます。本来はスレッド「${thread.title || '（無題）'}」の履歴 ${(thread.messages ?? []).length} 件と添付 ${(thread.attachments ?? []).length} 件を ${role.provider ?? 'プロバイダ未設定'} / ${role.model ?? 'モデル未設定'}（chatロール）へ送信します。`,
    'info'
  );
}

async function attachFiles(session, files) {
  const genre = chatGenre(session);
  const thread = activeThread(session, genre);
  if (!genre || !thread) return;
  for (const file of files) {
    try {
      const content = await file.text();
      await session.client.dispatch('attachment.create', {
        genreId: genre.id, threadId: thread.id,
        values: { name: file.name, type: file.type || 'text/plain', size: file.size, content },
      });
    } catch (error) {
      reportError(session, error);
    }
  }
}
