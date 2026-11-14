import { PANEL_TYPES } from './design-model.js';

const names = { chat: 'チャット', summary: '要約', memo: 'エピソードメモ', settings: '作品設定資料', 'project-memos': 'プロジェクトメモ', 'genre-chat': 'ジャンル専用チャット', 'genre-library': 'ジャンルライブラリ' };

export class DesignWindows {
  constructor(client, { saveView, onChange, onError }) {
    this.client = client;
    this.saveView = saveView;
    this.onChange = onChange;
    this.onError = onError;
    this.pending = new Map();
    this.handles = new Map();
    this.awaitingMain = null;
    const descriptor = client.descriptor;
    window.name = descriptor.surface === 'main' ? `litra-review-${descriptor.id}` : descriptor.detached ? this.windowName(descriptor.key) : `litra-review-${descriptor.id}`;
    client.events.addEventListener('layout', () => this.onChange());
    client.events.addEventListener('presence', () => {
      this.onChange();
      if (this.awaitingMain && client.views.some(view => view.surface === 'main')) {
        const key = this.awaitingMain;
        this.awaitingMain = null;
        this.reattach(key).catch(onError);
      }
    });
    client.events.addEventListener('reattach', event => {
      if (descriptor.surface !== 'main' && descriptor.detached && descriptor.key === event.detail) {
        this.closeAfterCommit().catch(onError);
      }
    });
    // MessagePort has no peer-close event; Window.closed covers a manually closed popup.
    this.closeMonitor = setInterval(() => {
      for (const [key, handle] of this.handles) {
        if (!handle.closed) continue;
        this.handles.delete(key);
        this.pending.delete(key);
        client.notifyClosed(key);
      }
    }, 800);
    window.addEventListener('pagehide', () => clearInterval(this.closeMonitor), { once: true });
  }

  windowName(key) { return `litra-review-panel-${encodeURIComponent(key)}`; }

  key(type, options) {
    return type === 'genre-chat' ? `genre-chat:${options.genreId}` : type;
  }

  get liveViews() {
    return this.client.views.filter(view => view.detached && this.pending.get(view.key)?.committed !== false);
  }

  isDetached(type) { return this.liveViews.some(view => view.type === type); }

  open(type, options = {}) {
    if (!PANEL_TYPES.includes(type)) { this.onError(new Error('分離対象が不正です。')); return null; }
    if (!this.client.state) { this.onError(new Error('画面案データを読み込み中です。')); return null; }
    if (type === 'genre-chat' && !this.client.state.genres.some(genre => genre.id === options.genreId)) {
      this.onError(new Error('先に対象ジャンルを選択してください。')); return null;
    }
    const key = this.key(type, options);
    const saved = this.client.state.layout.detached.find(item => item.key === key);
    const bounds = options.bounds || saved?.bounds || {};
    const width = Math.max(320, Math.min(Number(bounds.width) || (type === 'settings' ? 840 : 520), screen.availWidth));
    const height = Math.max(400, Math.min(Number(bounds.height) || 780, screen.availHeight));
    const locationFeatures = Number.isFinite(bounds.x) && Number.isFinite(bounds.y) ? `,left=${Math.round(bounds.x)},top=${Math.round(bounds.y)}` : '';
    const url = new URL(type === 'genre-library' ? './genres.html' : './panels.html', location.href);
    url.searchParams.set('type', type);
    url.searchParams.set('detached', '1');
    if (options.genreId) url.searchParams.set('genreId', options.genreId);
    url.hash = type;
    const known = this.handles.get(key);
    if (known && !known.closed) { known.focus(); return known; }

    // Begin the handoff now, but reserve the window before awaiting any async work.
    const savedView = Promise.resolve(this.saveView(type));
    const committed = this.client.flush();
    const existing = this.client.views.some(view => view.detached && view.key === key);
    const popup = window.open(existing ? '' : url.href, this.windowName(key), `popup,width=${Math.round(width)},height=${Math.round(height)}${locationFeatures}`);
    if (!popup) {
      savedView.catch(this.onError);
      committed.catch(this.onError);
      this.onError(new Error(`${names[type]}を開けませんでした。元の画面は維持しています。ブラウザのポップアップ許可を確認してください。`));
      return null;
    }
    // An independently opened main tab may be in a different browsing-context group.
    if (existing && popup.location.href === 'about:blank') popup.location.replace(url.href);
    this.handles.set(key, popup);
    this.pending.set(key, { committed: false });
    popup.focus();
    Promise.all([savedView, committed]).then(() => {
      const pending = this.pending.get(key);
      if (pending) pending.committed = true;
      this.onChange();
    }).catch(error => {
      this.onError(error);
      // Keep the source visible when its edits could not be committed.
    });
    return popup;
  }

  openMain(view = 'editor') {
    const main = this.client.views.find(item => item.surface === 'main');
    const url = new URL('./main.html', location.href);
    url.searchParams.set('view', view);
    const target = main ? `litra-review-${main.id}` : 'litra-review-main-new';
    const handle = window.open(main ? '' : url.href, target);
    if (!handle) { this.onError(new Error('主画面を開けません。ブラウザのポップアップ許可を確認してください。')); return null; }
    if (main && handle.location.href === 'about:blank') handle.location.replace(url.href);
    handle.focus();
    return handle;
  }

  async reattach(key = this.client.descriptor.key) {
    const descriptor = this.client.descriptor;
    if (descriptor.surface !== 'main' && !descriptor.detached) {
      await this.client.flush();
      await this.saveView(descriptor.type);
      location.href = 'main.html';
      return;
    }
    if (descriptor.surface !== 'main' && !this.client.views.some(view => view.surface === 'main')) {
      // This branch runs in the click handler, before any await, to retain user activation.
      if (this.openMain()) this.awaitingMain = key;
      return;
    }
    await this.client.flush();
    await this.saveView(descriptor.surface === 'main' ? key.split(':')[0] : descriptor.type);
    await this.client.dispatch('layout.forget', { key, reattach: true });
  }

  async closeAfterCommit() {
    await this.client.flush();
    await this.saveView(this.client.descriptor.type);
    this.client.saveGeometry();
    window.close();
    if (!window.closed) this.onError(new Error('再結合しました。このタブが残る場合は閉じてください。入力はブラウザ内に保存されています。'));
  }

  renderTray(root) {
    root.replaceChildren();
    const live = this.liveViews.filter(view => view.surface !== 'main');
    const liveKeys = new Set(live.map(view => view.key));
    const restore = this.client.state.layout.detached.filter(item => !liveKeys.has(item.key));
    root.hidden = !live.length && !restore.length;
    for (const view of live) {
      const row = document.createElement('div');
      row.className = 'design-window-row';
      const label = document.createElement('span');
      label.textContent = `${names[view.type]}を別表示中${view.genreId ? ` · ${this.client.state.genres.find(genre => genre.id === view.genreId)?.name || '削除済みジャンル'}` : ''}`;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'btn btn-small'; button.textContent = 'ここに戻す';
      button.addEventListener('click', () => this.reattach(view.key).catch(this.onError));
      row.append(label, button); root.append(row);
    }
    if (restore.length) {
      const label = document.createElement('p');
      label.textContent = '前回の別窓を復元（ブラウザでは操作ごとに開きます）';
      root.append(label);
      for (const item of restore) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'btn btn-small'; button.textContent = names[item.type];
        button.addEventListener('click', () => this.open(item.type, item));
        root.append(button);
      }
    }
  }
}
