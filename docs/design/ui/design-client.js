import { PANEL_TYPES, SCHEMA_VERSION } from './design-model.js';

function descriptor() {
  const url = new URL(location.href);
  const surface = document.body.dataset.designSurface;
  const hashType = url.hash.slice(1);
  const type = surface === 'main' ? 'main' : surface === 'genres' ? 'genre-library' : url.searchParams.get('type') || (PANEL_TYPES.includes(hashType) ? hashType : 'chat');
  const genreId = url.searchParams.get('genreId') || null;
  return { id: crypto.randomUUID(), surface, type, genreId,
    key: type === 'main' ? `main:${crypto.randomUUID()}` : type === 'genre-chat' ? `genre-chat:${genreId}` : type,
    detached: url.searchParams.get('detached') === '1',
    bounds: { x: window.screenX, y: window.screenY, width: innerWidth, height: innerHeight } };
}

class DesignClient {
  constructor() {
    this.state = null;
    this.views = [];
    this.descriptor = descriptor();
    this.events = new EventTarget();
    this._listeners = new Set();
    this._pending = new Map();
    this._flushers = new Set();
    this._localViews = new Map();
    this.ready = new Promise((resolve, reject) => { this._resolveReady = resolve; this._rejectReady = reject; });
    // The page can display a runtime error before a component begins awaiting ready.
    this.ready.catch(() => {});
    try {
      this.worker = new SharedWorker(new URL('./design-worker.js', import.meta.url), { name: 'litra-ui-design-review-v2', type: 'module' });
      this.worker.onerror = () => this._fail(new Error('共有実行主体を開始できません。SharedWorkerとIndexedDBを利用できるブラウザが必要です。'));
      this.worker.port.onmessage = event => this._receive(event.data);
      this.worker.port.start();
      this.worker.port.postMessage({ type: 'connect', protocol: SCHEMA_VERSION, descriptor: this.descriptor });
    } catch (error) { this._fail(error); }
  }

  _receive(message) {
    if (message.type === 'state') {
      if (this.state && message.state.revision < this.state.revision) return;
      this.state = message.state;
      this._resolveReady();
      for (const listener of this._listeners) listener(this.state);
    } else if (message.type === 'result') {
      if (message.requestId === 'connect' && message.error) { this._fail(Object.assign(new Error(message.error.message), message.error)); return; }
      const pending = this._pending.get(message.requestId);
      if (!pending) return;
      this._pending.delete(message.requestId);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), message.error));
      else pending.resolve(message.result);
    } else if (message.type === 'view-state') {
      this._localViews.set(message.key, message.value);
      this.events.dispatchEvent(new CustomEvent('view-state', { detail: message }));
    } else if (message.type === 'layout-state') {
      if (!this.state) return;
      this.state = { ...this.state, revision: message.revision, layout: message.layout };
      this.events.dispatchEvent(new CustomEvent('layout', { detail: message.layout }));
    } else if (message.type === 'presence') {
      this.views = message.views;
      this.events.dispatchEvent(new CustomEvent('presence', { detail: this.views }));
    } else if (message.type === 'reattach') {
      this.events.dispatchEvent(new CustomEvent('reattach', { detail: message.key }));
    } else if (message.type === 'notice') {
      this.events.dispatchEvent(new CustomEvent('notice', { detail: message.error }));
    }
  }

  _fail(error) {
    this.error = error;
    this._rejectReady(error);
    for (const pending of this._pending.values()) pending.reject(error);
    this._pending.clear();
    this.events.dispatchEvent(new CustomEvent('notice', { detail: error }));
  }

  _request(message) {
    if (this.error) return Promise.reject(this.error);
    const requestId = crypto.randomUUID();
    const done = new Promise((resolve, reject) => this._pending.set(requestId, { resolve, reject }));
    this._pending.get(requestId).done = done;
    this.worker.port.postMessage({ ...message, requestId });
    return done;
  }

  async dispatch(command, payload = {}) {
    await this.ready;
    return this._request({ type: 'command', command, payload });
  }

  subscribe(listener) {
    this._listeners.add(listener);
    if (this.state) listener(this.state);
    return () => this._listeners.delete(listener);
  }

  addFlusher(flush, isDirty = () => false) {
    const entry = { flush, isDirty };
    this._flushers.add(entry);
    return () => this._flushers.delete(entry);
  }

  get hasPending() {
    return this._pending.size > 0 || [...this._flushers].some(entry => entry.isDirty());
  }

  async flush() {
    await this.ready;
    do {
      await Promise.all([...this._flushers].map(entry => entry.flush()));
      while (this._pending.size) await Promise.all([...this._pending.values()].map(pending => pending.done));
    } while ([...this._flushers].some(entry => entry.isDirty()));
    await this._request({ type: 'barrier' });
  }

  openPanel(type, options = {}) {
    if (!this.windowDriver) throw new Error('ウィンドウ操作の準備が完了していません。');
    return this.windowDriver.open(type, options);
  }

  navigateMain(view) {
    if (!this.mainDriver) throw new Error('主画面の準備が完了していません。');
    return this.mainDriver(view);
  }

  markReady() { this.worker.port.postMessage({ type: 'ready' }); }
  notifyClosed(key) { this.worker.port.postMessage({ type: 'closed-window', key }); }
  saveGeometry() {
    this.worker?.port.postMessage({ type: 'geometry', bounds: { x: window.screenX, y: window.screenY, width: innerWidth, height: innerHeight } });
  }
  async saveViewState(key, value) {
    this._localViews.set(key, value);
    await this.dispatch('view.save', { key, value });
  }
  loadViewState(key) { return this._localViews.get(key) || this.state?.layout.viewState[key]; }
  disconnect() {
    this.worker?.port.postMessage({ type: 'disconnect' });
    this.worker?.port.close();
  }
}

export const client = new DesignClient();
