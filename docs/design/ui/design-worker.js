import { applyCommand, createInitialState, SCHEMA_VERSION } from './design-model.js';

const connections = new Map();
let state;
let database;
let queue = Promise.resolve();

function storageError(error) {
  return { code: 'STORAGE', message: `画面案のブラウザ保存に失敗しました。入力は閉じずに確認してください。${error?.message ? ` (${error.message})` : ''}` };
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('litra-ui-design-review-v2', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspace');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('別画面が古いデータベースを使用しています。'));
  });
}

function readSaved() {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('workspace', 'readonly');
    const request = transaction.objectStore('workspace').get('state');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function save(next) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('workspace', 'readwrite');
    transaction.objectStore('workspace').put(next, 'state');
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error('保存が中止されました。'));
  });
}

const initialized = (async () => {
  database = await openDatabase();
  const saved = await readSaved();
  if (saved && saved.schemaVersion !== SCHEMA_VERSION) throw new Error('画面案データのバージョンが異なります。既存データを自動で上書きしません。');
  state = saved || createInitialState();
  if (!saved) await save(state);
})();
// Initialization errors are delivered through each connection, not hidden by a memory fallback.
initialized.catch(() => {});

function serial(work) {
  const result = queue.then(() => initialized).then(work);
  queue = result.catch(() => {});
  return result;
}

function broadcast(message) {
  for (const connection of connections.values()) connection.port.postMessage(message);
}

function broadcastPresence() {
  broadcast({ type: 'presence', views: [...connections.values()].filter(connection => connection.ready).map(connection => connection.descriptor) });
}

async function commit(type, payload) {
  const change = applyCommand(state, type, payload);
  try { await save(change.state); } catch (error) { throw storageError(error); }
  state = change.state;
  if (type === 'view.save') broadcast({ type: 'view-state', key: payload.key, value: payload.value });
  else if (type === 'layout.remember' || type === 'layout.forget') broadcast({ type: 'layout-state', revision: state.revision, layout: state.layout });
  else if (change.broadcast) broadcast({ type: 'state', state });
  return change.result;
}

function disconnect(id) {
  const connection = connections.get(id);
  if (!connection) return;
  connections.delete(id);
  broadcastPresence();
  if (connection.descriptor.detached && [...connections.values()].some(item => item.descriptor.surface === 'main')) {
    serial(() => commit('layout.forget', { key: connection.descriptor.key })).catch(error => broadcast({ type: 'notice', error: storageError(error) }));
  }
  connection.port.close();
}

self.onconnect = event => {
  const port = event.ports[0];
  let connection;
  const replyError = (requestId, error) => port.postMessage({ type: 'result', requestId, error: { code: error.code || 'RUNTIME', message: error.message || String(error) } });

  port.onmessage = ({ data }) => {
    if (data.type === 'connect') {
      if (connection) return;
      if (data.protocol !== SCHEMA_VERSION) { replyError('connect', { code: 'VERSION', message: '画面と実行主体のバージョンが異なります。全画面を再読み込みしてください。' }); return; }
      connection = { descriptor: data.descriptor, port, ready: false };
      connections.set(data.descriptor.id, connection);
      serial(() => port.postMessage({ type: 'state', state, initial: true })).catch(error => replyError('connect', storageError(error)));
      return;
    }
    if (!connection) return;
    if (data.type === 'ready') {
      connection.ready = true;
      broadcastPresence();
    } else if (data.type === 'command') {
      serial(async () => {
        const result = await commit(data.command, data.payload);
        port.postMessage({ type: 'result', requestId: data.requestId, result });
        if (data.command === 'layout.forget' && data.payload.reattach) broadcast({ type: 'reattach', key: data.payload.key });
      }).catch(error => replyError(data.requestId, error));
    } else if (data.type === 'barrier') {
      serial(() => port.postMessage({ type: 'result', requestId: data.requestId, result: {} })).catch(error => replyError(data.requestId, error));
    } else if (data.type === 'disconnect') {
      disconnect(connection.descriptor.id);
    } else if (data.type === 'closed-window') {
      for (const [id, other] of connections) if (other.descriptor.key === data.key && other.descriptor.surface !== 'main') disconnect(id);
    } else if (data.type === 'geometry') {
      connection.descriptor.bounds = data.bounds;
      const descriptor = state?.layout.detached.find(item => item.key === connection.descriptor.key);
      if (descriptor) serial(() => commit('layout.remember', { descriptor: { ...descriptor, bounds: data.bounds } })).catch(error => port.postMessage({ type: 'notice', error: storageError(error) }));
    }
  };
  port.start();
};
