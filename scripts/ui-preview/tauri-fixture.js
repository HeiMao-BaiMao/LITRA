/* Preview-only adapter. All content is fictional; writes last only for this page.
 * The actual production Rust/WASM application renders and handles the interface.
 * There is deliberately no native IPC, keychain, login, sync, or remote API bridge.
 */
(() => {
  "use strict";
  const params = new URLSearchParams(location.search);
  const mode = params.get("fixture") || "populated";
  const base = new URL(".", location.href);
  const empty = mode === "empty";
  const copy = value => value == null ? value : structuredClone(value);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const date = "2026-10-01T09:00:00.000Z";
  const providers = window.__LITRA_PREVIEW_PROVIDERS__;
  const catalog = providers.map(p => ({ ...p, fixedModels: p.modelSelection === "fixed" }));
  const openai = providers.find(p => p.id === "openai") || providers[0];
  const projects = empty ? [] : [
    { id: "preview-project", title: "夜明けの図書館", createdAt: date, updatedAt: date },
    { id: "preview-project-2", title: "雨の街の記録", createdAt: date, updatedAt: date }
  ];
  const episodes = empty ? [] : [
    { id: "ep-1", title: "第一話　届かなかった手紙", order: 0, fileName: "ep-1.txt" },
    { id: "ep-2", title: "第二話　雨音の向こう", order: 1, fileName: "ep-2.txt" },
    { id: "ep-3", title: "第三話　夜明けを待つ人", order: 2, fileName: "ep-3.txt" }
  ];
  const texts = {
    "ep-1.txt": "　雨がやんだことに、灯はしばらく気づかなかった。\n\n　古い図書館の窓には、街灯の光が細い線になって残っている。閉館を知らせる時計は、もう十分前に鳴った。それでも彼女は、返却された一冊の本から目を離せずにいた。\n\n　ページのあいだから、薄い封筒がのぞいていた。宛名はない。ただ、青いインクで一行だけ。\n\n　――夜明けまでに、ここへ。\n\n　灯は封筒を裏返した。見覚えのある筆跡だった。三年前にこの街を出たはずの、兄の文字に似ている。\n\n「まだ、帰らないんですか」\n\n　入り口から声がした。振り返ると、濡れた傘を持った青年が立っていた。いつ入ってきたのか、足音は聞こえなかった。\n\n　灯は封筒を本に戻した。\n\n「忘れ物を、探しているんです」\n\n　そう答えてから、それが自分にも向けた言葉だったことに気づいた。",
    "ep-2.txt": "　図書館を出ると、石畳にはまだ雨の匂いが残っていた。\n\n　青年は名を律と告げ、それ以上は何も言わずに歩き出した。灯は少しだけ距離をあけて、その背中を追った。",
    "ep-3.txt": "　空が白み始めるころ、二人は港にたどり着いた。\n\n　誰もいない桟橋の先に、灯りが一つだけ揺れていた。"
  };
  const messages = empty ? [] : [
    { id: "chat-1", role: "user", content: "冒頭の静かな空気を保ちながら、手紙への好奇心を少し強めたいです。", createdAt: date },
    { id: "chat-2", role: "assistant", content: "封筒を開く前の小さなためらいを入れると、静けさを保てそうです。\n\nたとえば、指先に残る紙の冷たさや、兄の筆跡に気づく瞬間を一つずつ描いてみましょう。青年の登場は、その余韻のあとに置くと自然です。", createdAt: date }
  ];
  const characters = empty ? [] : [
    { id: "char-1", name: "灯（あかり）", role: "主人公", age: "27", gender: "女性", personality: "慎重で観察力がある。気持ちを言葉にするのは苦手。", appearance: "短い黒髪。使い込んだ腕時計。", background: "街の図書館で働く。三年前に姿を消した兄の手紙を見つける。", description: "忘れていた約束を探す司書。", speechStyle: "静かな口調。相手の返事を待ってから話す。", notes: "本に触れる仕草で感情を表す。" },
    { id: "char-2", name: "律（りつ）", role: "案内人", personality: "口数は少ないが親切。", description: "雨の夜、図書館に現れる青年。" }
  ];
  const worlds = empty ? [] : [
    { id: "world-1", name: "旧市立図書館", category: "場所", description: "港町の丘に建つ古い図書館。閉館後も窓辺に灯りが残る。", notes: "雨と紙の匂い。木製の書架。" },
    { id: "world-2", name: "夜明けの港", category: "場所", description: "潮が満ちる直前だけ、古い桟橋へ渡れる。" }
  ];
  const memos = empty ? [] : [
    { id: "memo-1", title: "物語の芯", content: "手紙を探す旅が、自分の言葉を取り戻す旅になる。\n静けさと余韻を大切にする。", updatedAt: date },
    { id: "memo-2", title: "伏線の整理", content: "青いインク／腕時計／閉館の鐘", updatedAt: date }
  ];
  const documents = {
    summaries: { summaries: { "ep-1": { content: "閉館後の図書館で、灯は兄の筆跡に似た手紙を見つける。そこへ見知らぬ青年が現れる。" } } },
    memos: { memos: { "ep-1": { content: "・雨音が消えた瞬間から始める\n・兄の不在は説明しすぎない\n・青年の足音がしないことを伏線に" } } },
    chat: { schemaVersion: 2, messages, session: { updatedAt: date } },
    relationships: { "ep-1": { "char-1_char-2": "手紙の秘密を共有する" } }
  };
  const settingsDefault = {
    provider: openai.id, model: openai.defaultModel, apiKey: "", baseUrl: openai.defaultBaseUrl,
    chatProvider: openai.id, chatModel: openai.defaultModel, temperature: 1,
    openaiReasoningEffort: "medium", chatSubmitShortcut: "ctrlEnter",
    twoStageContinuation: true, continuationReviewEnabled: true,
    continuationSceneStateEnabled: true, continuationCharacterVoiceEnabled: true,
    continuationBestOfTwo: false, continuationTargetedRevision: true,
    continuationBeatSplitEnabled: false, commonSenseAuditEnabled: true,
    commonSensePlanCheckEnabled: true, craftQualityDensityEnabled: true,
    craftQualityPovEnabled: true, craftQualityLogicEnabled: true,
    webSearchPriority: ["openai-web-search", "anthropic-web-search", "google-search", "exa"],
    providerConfigs: Object.fromEntries(providers.map(p => [p.id, { model: p.defaultModel, baseUrl: p.defaultBaseUrl, apiKey: "" }]))
  };
  let settings = copy(settingsDefault);
  let layout = null;
  let webdav = { enabled: false, baseUrl: "", username: null, password: null, remoteFolder: "LITRA" };
  const calls = [], unsupported = [], errors = [], streams = new Map();
  const listeners = new Map();
  const latest = new Map();
  const bus = typeof BroadcastChannel === "function" ? new BroadcastChannel("litra-preview:" + base.pathname) : null;
  function deliver(name, payload) {
    latest.set(name, copy(payload));
    for (const callback of listeners.get(name) || []) callback({ event: name, payload: copy(payload), id: 1 });
  }
  if (bus) bus.onmessage = ({ data }) => deliver(data.name, data.payload);
  const seed = {
    "summary-sync": { episodeId: empty ? null : "ep-1", content: empty ? "" : documents.summaries.summaries["ep-1"].content },
    "memo-sync": { episodeId: empty ? null : "ep-1", content: empty ? "" : documents.memos.memos["ep-1"].content },
    "chat-sync": { messages, isGenerating: false, directWritingEnabled: false },
    "chat-settings-sync": { provider: openai.id, model: openai.defaultModel, chatSubmitShortcut: "ctrlEnter", providerConfig: { providers: catalog } },
    "settings-sync": { view: "characters", characters, worldEntries: worlds, episodes, relationshipsMap: documents.relationships, currentCharacterId: characters[0]?.id || null, currentWorldEntryId: worlds[0]?.id || null },
    "project-memos-sync": { memos, currentMemoId: memos[0]?.id || null }
  };
  const event = {
    async listen(name, callback) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(callback);
      return () => listeners.get(name)?.delete(callback);
    },
    async emit(name, payload) {
      // Rust serde-wasm-bindgen represents JSON objects as Maps in outgoing events.
      payload = normalize(payload);
      deliver(name, payload);
      bus?.postMessage({ name, payload });
      const kind = document.body?.dataset.rustWindow;
      if (kind !== "main" && name.endsWith("-ready")) {
        for (const [syncName, value] of Object.entries(seed)) deliver(syncName, latest.get(syncName) || value);
      }
    }
  };
  function normalize(value) {
    if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [k, normalize(v)]));
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
    return value;
  }
  function runtime(args) {
    const provider = args.providerOverride || settings.chatProvider || settings.provider;
    const p = providers.find(item => item.id === provider) || openai;
    const model = args.modelOverride || settings.chatModel || p.defaultModel;
    const m = p.models.find(item => item.id === model) || p.models[0] || {};
    return { provider: p.id, apiType: p.connections?.[0]?.apiType || "openai-responses", apiKey: "", baseUrl: p.defaultBaseUrl,
      model, maxOutputTokens: m.maxTokens || 8192, maxContextTokens: m.maxContextTokens || 128000,
      temperature: 1, topP: null, topK: null, frequencyPenalty: null, presencePenalty: null,
      reasoningEffort: "medium", thinkingEnabled: null, thinkingBudget: null,
      anthropicThinkingEffort: null, thinkingLevel: null, promptScaffold: "light" };
  }
  async function invoke(command, raw = {}) {
    const args = normalize(raw) || {};
    calls.push({ command, at: performance.now() }); // Never retain input/key fields.
    switch (command) {
      case "ai_provider_catalog": return copy(catalog);
      case "ai_settings_snapshot": return copy(settings);
      case "ai_settings_save": settings = copy(args.settings); return null;
      case "ai_settings_reset": settings = copy(settingsDefault); return null;
      case "ai_runtime_config": return runtime(args);
      case "ai_list_models":
        if (mode === "loading") await new Promise(() => {});
        await wait(350);
        if (mode === "error") throw "プレビュー用エラー：モデルの取得に失敗しました。実際の通信は行っていません。";
        return (providers.find(p => p.id === args.request.provider)?.models || []).map(m => ({ id: m.id, modelPickerEnabled: true }));
      case "ai_stream_text": {
        if (mode === "error") throw "プレビュー用エラー：生成を開始できませんでした。実際の通信は行っていません。";
        let resolve;
        const done = new Promise(r => { resolve = r; });
        const stream = { cancelled: false, resolve };
        streams.set(args.request.requestId, stream);
        if (mode === "loading") {
          await done;
          raw.onEvent.onmessage?.({ type: "cancelled" });
          return null;
        }
        const chunks = ["これは UI プレビュー用の固定応答です。", "\n\n封筒に触れる指先の描写を一文足すと、", "灯のためらいが静かに伝わりそうです。"];
        for (const delta of chunks) {
          await wait(450);
          if (stream.cancelled) break;
          raw.onEvent.onmessage?.({ type: "text_delta", delta });
        }
        raw.onEvent.onmessage?.({ type: stream.cancelled ? "cancelled" : "finished", finish_reason: "stop" });
        streams.delete(args.request.requestId);
        return null;
      }
      case "ai_cancel": {
        const stream = streams.get(args.requestId);
        if (stream) { stream.cancelled = true; stream.resolve(); streams.delete(args.requestId); }
        return null;
      }
      case "project_list": return copy(projects);
      case "project_load": case "project_touch": return copy(projects.find(p => p.id === args.projectId) || projects[0]);
      case "project_create": {
        const project = { id: crypto.randomUUID(), title: args.title, createdAt: date, updatedAt: date };
        projects.push(project); return copy(project);
      }
      case "project_rename": { const p = projects.find(p => p.id === args.projectId); p.title = args.newTitle; return copy(p); }
      case "project_delete": { const i = projects.findIndex(p => p.id === args.projectId); if (i >= 0) projects.splice(i, 1); return null; }
      case "project_list_episodes": return copy(episodes);
      case "project_read_episode": return texts[args.fileName] || "";
      case "project_write_episode": texts[args.fileName] = args.content; return null;
      case "project_create_episode": {
        const id = crypto.randomUUID(); const ep = { id, title: args.title, order: episodes.length, fileName: id + ".txt" };
        episodes.push(ep); return copy(ep);
      }
      case "project_update_episode_title": { const ep = episodes.find(e => e.id === args.episodeId); if (ep) ep.title = args.title; return null; }
      case "project_delete_episode": { const i = episodes.findIndex(e => e.id === args.episodeId); if (i >= 0) episodes.splice(i, 1); return null; }
      case "project_reorder_episodes": episodes.sort((a,b) => args.orderedIds.indexOf(a.id) - args.orderedIds.indexOf(b.id)); return null;
      case "project_read_document": return copy(documents[args.kind] || null);
      case "project_write_document": documents[args.kind] = copy(args.value); return null;
      case "list_characters": return { characters: copy(characters) };
      case "list_world_entries": return { entries: copy(worlds) };
      case "list_project_memos": return copy(memos);
      case "load_last_project_id": return projects[0]?.id || null;
      case "load_window_bounds": return null;
      case "load_window_detached": return false;
      case "layout_load": return layout;
      case "layout_save": layout = typeof args === "string" ? args : null; return null;
      case "load_webdav_sync_config": return copy(webdav);
      case "save_webdav_sync_config": webdav = copy(args.config); return null;
      case "secret_get": return null;
      case "secret_set": case "secret_delete": return null; // No credential persistence.
      case "oauth_credential_status": return false;
      case "oauth_credential_delete": return null;
      case "plugin:updater|check": return null;
      case "genre_read_index": return JSON.stringify({ schemaVersion: 1, genres: [] });
      case "genre_read_text": return null;
      case "migrate_legacy_app_data": case "rebuild_search_index": return {};
      case "save_last_project_id": case "save_window_bounds": case "save_window_detached": return null;
      default:
        unsupported.push(command);
        console.warn("[litra-preview] Unsupported fixture command:", command);
        throw `UI preview does not implement ${command}. No native operation or network request was made.`;
    }
  }
  const noop = async () => {};
  const unsubscribe = async () => () => {};
  const nativeWindows = new Map();
  const currentWindow = {
    label: document.body?.dataset.rustWindow || "main", scaleFactor: async () => devicePixelRatio || 1,
    onScaleChanged: unsubscribe, onCloseRequested: unsubscribe, onMoved: unsubscribe, onResized: unsubscribe,
    isMaximized: async () => false, outerPosition: async () => ({ x: 0, y: 0 }),
    outerSize: async () => ({ width: innerWidth, height: innerHeight }),
    setPosition: noop, setSize: noop, show: noop, setFocus: noop, destroy: noop
  };
  class WebviewWindow {
    constructor(label, options) {
      this.label = label;
      const url = new URL(options.url.replace(/^\//, ""), base);
      url.searchParams.set("fixture", mode);
      this.child = window.open(url, "litra-preview-" + label);
      nativeWindows.set(label, this);
    }
    static async getByLabel(label) { const win = nativeWindows.get(label); return win?.child?.closed ? null : win || null; }
    async once(name, callback) { if (name === "tauri://created") setTimeout(callback, 0); }
    async show() {} async setFocus() { this.child?.focus(); }
    async destroy() { this.child?.close(); nativeWindows.delete(this.label); }
    onMoved = unsubscribe; onResized = unsubscribe; setPosition = noop; setSize = noop;
  }
  window.__TAURI__ = {
    core: { invoke, Channel: class { onmessage = null; } }, event,
    window: { getCurrentWindow: () => currentWindow, availableMonitors: async () => [],
      PhysicalPosition: class { constructor(x,y) { this.x = x; this.y = y; } },
      PhysicalSize: class { constructor(width,height) { this.width = width; this.height = height; } } },
    webview: { getCurrentWebview: () => ({ setZoom: noop }) },
    webviewWindow: { WebviewWindow, getAllWebviewWindows: async () => [...nativeWindows.values()] },
    opener: { openUrl: async () => { throw "External links and sign-in are disabled in this fictional preview."; } }
  };
  window.__LITRA_PREVIEW__ = { mode, calls, unsupported, errors, backend: "fictional in-memory fixture", emit: event.emit };
  addEventListener("error", e => errors.push(e.message));
  addEventListener("unhandledrejection", e => errors.push(String(e.reason)));
  addEventListener("DOMContentLoaded", () => {
    const badge = document.createElement("div");
    badge.textContent = `UI PREVIEW · 架空データ · ${mode}`;
    badge.id = "preview-fixture-badge";
    badge.setAttribute("role", "note");
    badge.style.cssText = "position:fixed;left:8px;bottom:6px;z-index:99999;padding:4px 8px;background:#173d39;color:#fff;border-radius:4px;font:10px/1.3 system-ui;pointer-events:none;opacity:.82";
    document.body.append(badge);
  });
})();
