// This dataset belongs only to the UI review, never to the native LITRA library.
export const SCHEMA_VERSION = 2;
export const PANEL_TYPES = ['chat', 'summary', 'memo', 'settings', 'project-memos', 'genre-chat', 'genre-library'];

export class DesignError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const fail = (code, message) => { throw new DesignError(code, message); };
const timestamp = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const find = (items, id, label) => items.find(item => item.id === id) || fail('NOT_FOUND', `${label}が見つかりません。別画面で削除された可能性があります。`);
const checkRevision = (item, expected) => {
  if (expected !== undefined && expected !== item.revision) fail('CONFLICT', '別画面で更新されています。入力を残したまま最新の内容と比較してください。');
};
const touch = item => { item.revision = (item.revision || 0) + 1; item.updatedAt = timestamp(); };
const patch = (item, changes) => {
  for (const [key, value] of Object.entries(changes || {})) {
    if (!['id', 'revision', 'createdAt', 'updatedAt'].includes(key)) item[key] = value;
  }
  touch(item);
};
const collectionName = kind => ({ character: 'characters', world: 'worldEntries', projectMemo: 'projectMemos' }[kind]) || fail('INVALID', '編集対象の種類が不正です。');

export function segmentSource(source) {
  const content = source.content || '';
  const segments = [];
  const pattern = /[^\r\n]+(?:\r?\n(?!\r?\n)[^\r\n]+)*/gu;
  for (const match of content.matchAll(pattern)) {
    segments.push({ id: `${source.id}-segment-${segments.length + 1}`, ordinal: segments.length,
      heading: match[0].split('\n')[0].replace(/^#+\s*/, '').slice(0, 60),
      startOffset: match.index, endOffset: match.index + match[0].length,
      segmentationMethod: 'design-review-paragraphs' });
  }
  source.segments = segments;
  source.characterCount = [...content].length;
  source.segmentCount = segments.length;
}

function project(id, title, alternate = false) {
  const now = timestamp();
  const prefix = id;
  const episodes = [1, 2, 3].map((order, index) => ({
    id: `${prefix}-episode-${order}`, title: alternate ? ['序章', '旅の支度', '星の行方'][index] : ['灯りの届く場所', '貸出カードの名前', '潮のかえり道'][index],
    order: index, revision: 1,
    content: alternate ? '山の駅で列車を降りると、星はまだ朝の空に残っていた。\n\nこれは別作品の表示例です。作品を切り替えても、元の作品の入力とは混ざりません。' : '三月もなかばを過ぎても、浜の町の夕方は早かった。灯子が返却棚のカードを整理しているあいだに、窓の外の薄明は一枚ずつ色を落としてゆき、やがて海だけが黒く残った。\n\n「今日は潮の音が近いね」\n\nカウンターの向こうで、老館長が眼鏡も拭かずに言った。潮騒は防波堤を越えて、図書館の石段をのぼり、閉架の扉の隙間からこちらを覗いているようだった。\n\n「潮がかえってくるんですよ」と館長は言った。「昔はこのへんまで海だった。建物は覚えているものさ」\n\n灯子は黙って頷き、それから自分が頷いた理由を考えた。\n\n返却箱の文庫本に残る砂をつまみあげたとき、彼女はようやく気づいた。待っていたのは誰かの足音ではなく、この音のほうだったのかもしれない。',
    oneLiner: alternate ? '山の駅から、星を探す旅が始まる。' : '潮騒の近づく夜、灯子は図書館が自分を待っている予感に気づきはじめる。',
    summary: alternate ? '別作品の要約です。資料・メモ・会話は作品ごとに分けて管理します。' : '閉館作業のなか、館長の「潮がかえってくる」という言葉が灯子の海への距離感を書きかえる。文庫本に残る砂が、町と図書館の由来を示唆する。',
    memo: alternate ? '旅の時間帯を確認する。' : '・館長の言葉は後半の伏線。\n・文庫本の砂と貸出カードを結びつける。',
  }));
  const characters = [
    { id: `${prefix}-character-1`, revision: 1, name: alternate ? '律' : '灯子', reading: alternate ? 'りつ' : 'とうこ', role: '主人公', age: '27', personality: '言葉よりも手触りから物事を確かめる。', background: '故郷を離れ、新しい町へ来た。', customFields: [{ label: '大切なもの', value: alternate ? '古い切符' : '返却棚の貸出カード' }], createdAt: now, updatedAt: now },
    { id: `${prefix}-character-2`, revision: 1, name: alternate ? '駅長' : '館長', role: '案内役', notes: '説明しすぎず、短い台詞で過去を示す。', customFields: [], createdAt: now, updatedAt: now },
  ];
  return { id, title, revision: 1, episodes, characters,
    worldEntries: [{ id: `${prefix}-world-1`, revision: 1, name: alternate ? '山の駅' : '浜の図書館', category: '場所', geography: alternate ? '山間の終着駅。' : '防波堤の石段を上がった先。かつて海だった土地に建つ。', history: '町の記憶を集める場所。', customFields: [], createdAt: now, updatedAt: now }],
    relationships: { groups: [{ episodeId: '', revision: 1, relationships: [{ id: `${prefix}-relationship-1`, characterAId: characters[0].id, characterBId: characters[1].id, direction: 'mutual', description: '互いに過去を尋ねず、居場所を分け合う。' }] }] },
    projectMemos: [{ id: `${prefix}-project-memo-1`, revision: 1, title: '作品全体の伏線', content: '最終話で、冒頭の音のモチーフを回収する。\nこれは各話のメモとは別の、作品全体のメモです。', createdAt: now, updatedAt: now }],
    selection: { episodeId: episodes[2].id, characterId: characters[0].id, worldId: `${prefix}-world-1`, projectMemoId: `${prefix}-project-memo-1`, settingsTab: 'characters', relationshipEpisodeId: '' },
    chat: { input: '', provider: 'Anthropic', model: 'claude-sonnet-4', directWriting: false, job: null,
      messages: [{ id: `${prefix}-message-1`, role: 'user', content: alternate ? 'この旅の導入を考えたい。' : '三章の導入、潮騒の距離感はこれで合っているかな。', isExample: true },
        { id: `${prefix}-message-2`, role: 'assistant', content: alternate ? 'この会話は別作品の表示例です。実際のAI応答ではありません。' : '台詞の直後に灯子の感覚へ戻る一文を足すと、視点の流れが安定します。これは画面デザイン用の会話例です。', provider: 'Anthropic', model: 'claude-sonnet-4', isExample: true }] },
  };
}

export function createInitialState() {
  const now = timestamp();
  const first = project('project-tide', '潮騒文庫');
  const second = project('project-stars', '星を待つ駅', true);
  const source = { id: 'source-library', revision: 1, genreId: 'genre-literary', title: '潮の帰る図書館（架空の参考資料）', author: '表示例', sourceType: 'novel', sourceRole: 'reference', preference: 'neutral', sourceNote: '原資料はジャンルの定義や承認済み知識とは別に扱う。', userInterpretation: '', mediaType: 'text/markdown', language: 'ja', content: '# 閉館の時刻\n灯子は返却棚のカードをそろえた。潮の音が石段を上がってきた。\n\n# ひと粒の砂\n文庫本の小口に残った砂が、町の過去と今をつないだ。', analysisStatus: 'completed', latestAnalysisRunId: 'analysis-example', createdAt: now, updatedAt: now };
  segmentSource(source);
  const sourceReferences = [{ sourceId: source.id, segmentId: source.segments[0].id, quote: '潮の音が石段を上がってきた。' }];
  const genre = { id: 'genre-literary', revision: 1, schemaVersion: 1, name: '海辺の幻想文学', aliases: ['静かな幻想'], description: '日常の感覚と場所の記憶が交差する物語。', userDefinition: '異変を説明しきらず、人物の知覚を通じて読者に受け渡す。', notes: '一つの作品の固有名をジャンル全体の規則にしない。', tags: ['幻想', '場所の記憶'], status: 'active', createdAt: now, updatedAt: now,
    sources: [source],
    analyses: [{ id: 'analysis-example', sourceId: source.id, status: 'completed', summary: '場所の記憶を音と触覚で示す構成。単一資料の分析例であり、ジャンル全体の規則ではない。', segments: source.segments.map(segment => ({ segmentId: segment.id, content: '人物の感覚を起点に、日常と異変の境界を曖昧にする。表示例。' })), createdAt: now, isExample: true }],
    knowledge: { revision: 1,
      items: [{ id: 'knowledge-user', revision: 1, genreId: 'genre-literary', title: '人物の知覚から異変を描く', statement: '説明より先に、音・光・手触りで違和感を示す。', category: 'narrative', explanation: 'ユーザーが明示的に定義した知識の表示例。', importance: 'core', status: 'active', authority: 'user_explicit', confidence: 1, sourceReferences: [], chatReferences: [], createdAt: now, updatedAt: now }],
      candidates: [{ id: 'candidate-sound', revision: 1, genreId: 'genre-literary', title: '反復する音で場所の記憶をつなぐ', statement: '冒頭と終盤の環境音を変化させて、場所への関係の変化を表せる。', category: 'structure', explanation: '一つの参考資料に基づく未承認の分析候補。', proposedImportance: 'work_specific', status: 'pending', createdBy: 'ai', confidence: 0.72, sourceReferences, chatReferences: [], createdAt: now, updatedAt: now }] },
    chat: { activeThreadId: 'thread-genre-example', threads: [{ id: 'thread-genre-example', genreId: 'genre-literary', title: '日常と異変の境界', status: 'active', revision: 1, summary: '', input: '', attachments: [{ id: 'attachment-example', name: '参照箇所.md', type: 'text/markdown', size: 39, content: '潮の音が石段を上がってきた。表示例。' }], messages: [{ id: 'genre-message-example', threadId: 'thread-genre-example', role: 'assistant', content: '原資料、未承認候補、採用済み知識を区別して検討するための専用会話です。これは表示例で、AI接続はありません。', isExample: true, attachments: [] }], createdAt: now, updatedAt: now }] },
    selection: { tab: 'overview', sourceId: source.id, analysisId: 'analysis-example' },
  };
  return { schemaVersion: SCHEMA_VERSION, revision: 0, activeProjectId: first.id, activeEpisodeId: first.selection.episodeId, activeGenreId: genre.id, projects: [first, second], genres: [genre], settings: { roles: { chat: { provider: 'Anthropic', model: 'claude-sonnet-4' }, writing: { provider: 'OpenAI', model: 'gpt-5' }, judgment: { provider: 'Anthropic', model: 'claude-sonnet-4' }, background: { provider: 'OpenAI', model: 'gpt-5-mini' } } }, layout: { detached: [], viewState: {} } };
}

export function applyCommand(state, type, p = {}) {
  const next = structuredClone(state);
  const getProject = () => find(next.projects, p.projectId, '作品');
  const getGenre = () => find(next.genres, p.genreId, 'ジャンル');
  let result = {};
  let broadcast = true;
  switch (type) {
    case 'project.create': {
      const now = timestamp();
      const item = { id: uid(), title: p.title || '新しい作品', revision: 1, episodes: [], characters: [], worldEntries: [], relationships: { groups: [] }, projectMemos: [], selection: { episodeId: null, characterId: null, worldId: null, projectMemoId: null, settingsTab: 'characters', relationshipEpisodeId: '' }, chat: { messages: [], input: '', provider: next.settings.roles.chat.provider, model: next.settings.roles.chat.model, directWriting: false, job: null }, createdAt: now, updatedAt: now };
      next.projects.push(item); next.activeProjectId = item.id; next.activeEpisodeId = null; result = { id: item.id }; break;
    }
    case 'project.rename': { const item = getProject(); item.title = p.title; touch(item); break; }
    case 'project.delete': {
      getProject(); next.projects = next.projects.filter(item => item.id !== p.projectId);
      if (next.activeProjectId === p.projectId) {
        next.activeProjectId = next.projects[0]?.id || null;
        next.activeEpisodeId = next.projects[0]?.selection.episodeId || next.projects[0]?.episodes[0]?.id || null;
      }
      break;
    }
    case 'project.select': {
      const item = find(next.projects, p.projectId, '作品');
      next.activeProjectId = item.id;
      next.activeEpisodeId = item.episodes.some(e => e.id === item.selection.episodeId) ? item.selection.episodeId : item.episodes[0]?.id || null;
      break;
    }
    case 'episode.create': {
      const owner = getProject();
      const item = { id: uid(), title: p.title || '新しいエピソード', order: owner.episodes.length, revision: 1, content: '', oneLiner: '', summary: '', memo: '' };
      owner.episodes.push(item); owner.selection.episodeId = item.id;
      if (owner.id === next.activeProjectId) next.activeEpisodeId = item.id;
      result = { id: item.id }; break;
    }
    case 'episode.delete': {
      const owner = getProject(); find(owner.episodes, p.episodeId, 'エピソード');
      owner.episodes = owner.episodes.filter(item => item.id !== p.episodeId);
      owner.episodes.forEach((item, index) => { item.order = index; });
      owner.relationships.groups = owner.relationships.groups.filter(group => group.episodeId !== p.episodeId);
      if (owner.selection.episodeId === p.episodeId) owner.selection.episodeId = owner.episodes[0]?.id || null;
      if (owner.id === next.activeProjectId) next.activeEpisodeId = owner.selection.episodeId;
      break;
    }
    case 'episode.reorder': {
      const owner = getProject();
      if (!Array.isArray(p.ids) || p.ids.length !== owner.episodes.length || new Set(p.ids).size !== p.ids.length || p.ids.some(id => !owner.episodes.some(item => item.id === id))) fail('INVALID', 'エピソードの並び順が一致しません。');
      owner.episodes = p.ids.map((id, order) => ({ ...find(owner.episodes, id, 'エピソード'), order }));
      break;
    }
    case 'episode.select': {
      const item = getProject();
      find(item.episodes, p.episodeId, 'エピソード');
      item.selection.episodeId = p.episodeId;
      if (next.activeProjectId === item.id) next.activeEpisodeId = p.episodeId;
      break;
    }
    case 'episode.update': {
      const item = find(getProject().episodes, p.episodeId, 'エピソード');
      checkRevision(item, p.expectedRevision);
      patch(item, p.changes);
      break;
    }
    case 'selection.update':
      Object.assign(getProject().selection, p.changes);
      break;
    case 'entity.create': {
      const owner = getProject();
      const collection = collectionName(p.kind);
      const now = timestamp();
      const defaults = p.kind === 'projectMemo' ? { title: '新しいメモ', content: '' } : { name: p.kind === 'character' ? '新しい人物' : '新しい世界観', customFields: [] };
      const item = { ...defaults, ...p.values, id: uid(), revision: 1, createdAt: now, updatedAt: now };
      owner[collection].push(item);
      owner.selection[{ character: 'characterId', world: 'worldId', projectMemo: 'projectMemoId' }[p.kind]] = item.id;
      result = { id: item.id };
      break;
    }
    case 'entity.update': {
      const item = find(getProject()[collectionName(p.kind)], p.id, '資料');
      checkRevision(item, p.expectedRevision);
      patch(item, p.changes);
      break;
    }
    case 'entity.delete': {
      const owner = getProject();
      const collection = collectionName(p.kind);
      const item = find(owner[collection], p.id, '資料');
      checkRevision(item, p.expectedRevision);
      owner[collection] = owner[collection].filter(entry => entry.id !== item.id);
      const key = { character: 'characterId', world: 'worldId', projectMemo: 'projectMemoId' }[p.kind];
      if (owner.selection[key] === item.id) owner.selection[key] = owner[collection][0]?.id || null;
      // Keep relationship evidence instead of silently cascading unrelated deletions.
      break;
    }
    case 'relationships.update': {
      const owner = getProject();
      if (p.episodeId) find(owner.episodes, p.episodeId, 'エピソード');
      let group = owner.relationships.groups.find(item => item.episodeId === p.episodeId);
      if (!group) { group = { episodeId: p.episodeId, revision: 0, relationships: [] }; owner.relationships.groups.push(group); }
      checkRevision(group, p.expectedRevision);
      group.relationships = p.relationships;
      touch(group);
      break;
    }
    case 'genre.create': {
      const now = timestamp();
      const item = { schemaVersion: 1, name: '新しいジャンル', aliases: [], description: '', userDefinition: '', notes: '', tags: [], status: 'active', ...p.values, id: uid(), revision: 1, createdAt: now, updatedAt: now, sources: [], analyses: [], knowledge: { revision: 1, items: [], candidates: [] }, chat: { activeThreadId: null, threads: [] }, selection: { tab: 'overview', sourceId: null, analysisId: null } };
      next.genres.push(item); next.activeGenreId = item.id; result = { id: item.id }; break;
    }
    case 'genre.select': next.activeGenreId = getGenre().id; break;
    case 'genre.update': { const item = getGenre(); checkRevision(item, p.expectedRevision); patch(item, p.changes); break; }
    case 'genre.delete': {
      getGenre(); next.genres = next.genres.filter(item => item.id !== p.genreId);
      if (next.activeGenreId === p.genreId) next.activeGenreId = next.genres[0]?.id || null;
      break;
    }
    case 'genre.selection': Object.assign(getGenre().selection, p.changes); break;
    case 'source.create': {
      const genre = getGenre(); const now = timestamp();
      const item = { title: '新しい資料', content: '', author: '', sourceType: 'novel', sourceRole: 'reference', preference: 'neutral', sourceNote: '', userInterpretation: '', mediaType: 'text/markdown', language: 'ja', ...p.values, id: uid(), genreId: genre.id, revision: 1, analysisStatus: 'not_analyzed', latestAnalysisRunId: null, createdAt: now, updatedAt: now };
      segmentSource(item); genre.sources.push(item); genre.selection.sourceId = item.id; result = { id: item.id }; break;
    }
    case 'source.update': {
      const item = find(getGenre().sources, p.id, '原資料'); checkRevision(item, p.expectedRevision); patch(item, p.changes);
      if (Object.hasOwn(p.changes || {}, 'content')) { segmentSource(item); item.analysisStatus = 'not_analyzed'; item.latestAnalysisRunId = null; }
      break;
    }
    case 'source.delete': {
      const genre = getGenre(); find(genre.sources, p.id, '原資料'); genre.sources = genre.sources.filter(item => item.id !== p.id);
      if (genre.selection.sourceId === p.id) genre.selection.sourceId = genre.sources[0]?.id || null;
      break;
    }
    case 'knowledge.create': {
      const genre = getGenre(); const now = timestamp();
      const item = { title: '新しい知識', statement: '', category: 'general', explanation: '', importance: 'optional', status: 'active', authority: 'user_explicit', confidence: 1, sourceReferences: [], chatReferences: [], ...p.values, id: uid(), genreId: genre.id, revision: 1, createdAt: now, updatedAt: now };
      genre.knowledge.items.push(item); genre.knowledge.revision++; result = { id: item.id }; break;
    }
    case 'knowledge.update': { const genre = getGenre(); const item = find(genre.knowledge.items, p.id, '知識'); checkRevision(item, p.expectedRevision); patch(item, p.changes); genre.knowledge.revision++; break; }
    case 'knowledge.delete': { const genre = getGenre(); find(genre.knowledge.items, p.id, '知識'); genre.knowledge.items = genre.knowledge.items.filter(item => item.id !== p.id); genre.knowledge.revision++; break; }
    case 'knowledge.status': {
      if (!['active', 'disabled'].includes(p.status)) fail('INVALID', '知識の状態が不正です。');
      const genre = getGenre(); const item = find(genre.knowledge.items, p.id, '知識'); item.status = p.status; touch(item); genre.knowledge.revision++; break;
    }
    case 'candidate.status': {
      if (!['accepted', 'on_hold', 'rejected', 'pending'].includes(p.status)) fail('INVALID', '候補の状態が不正です。');
      const genre = getGenre(); const candidate = find(genre.knowledge.candidates, p.id, '知識候補');
      if (p.status === 'accepted' && !genre.knowledge.items.some(item => item.createdFromCandidateId === candidate.id)) {
        const now = timestamp();
        genre.knowledge.items.push({ id: uid(), revision: 1, genreId: genre.id, title: candidate.title, statement: candidate.statement, category: candidate.category, explanation: candidate.explanation, importance: candidate.proposedImportance === 'work_specific' ? 'optional' : candidate.proposedImportance, status: 'active', authority: candidate.createdBy === 'user' ? 'user_explicit' : 'user_approved_ai', confidence: candidate.confidence, sourceReferences: candidate.sourceReferences, chatReferences: candidate.chatReferences, createdFromCandidateId: candidate.id, createdAt: now, updatedAt: now });
        genre.knowledge.revision++;
      }
      candidate.status = p.status; touch(candidate); break;
    }
    case 'thread.create': {
      const genre = getGenre(); const now = timestamp();
      const item = { id: uid(), genreId: genre.id, title: p.title || '新しい会話', status: 'active', revision: 1, summary: '', input: '', attachments: [], messages: [], createdAt: now, updatedAt: now };
      genre.chat.threads.push(item); genre.chat.activeThreadId = item.id; result = { id: item.id }; break;
    }
    case 'thread.select': { const genre = getGenre(); find(genre.chat.threads, p.id, '会話'); genre.chat.activeThreadId = p.id; break; }
    case 'thread.rename': { const thread = find(getGenre().chat.threads, p.id, '会話'); thread.title = p.title; touch(thread); break; }
    case 'thread.archive': { const thread = find(getGenre().chat.threads, p.id, '会話'); thread.status = 'archived'; touch(thread); break; }
    case 'thread.delete': {
      const genre = getGenre(); find(genre.chat.threads, p.id, '会話'); genre.chat.threads = genre.chat.threads.filter(item => item.id !== p.id);
      if (genre.chat.activeThreadId === p.id) genre.chat.activeThreadId = genre.chat.threads[0]?.id || null;
      break;
    }
    case 'attachment.create': {
      const thread = find(getGenre().chat.threads, p.threadId, '会話');
      const item = { name: '添付資料', type: 'text/plain', ...p.values, id: uid() };
      item.size = new TextEncoder().encode(item.content || '').length;
      thread.attachments.push(item); touch(thread); result = { id: item.id }; break;
    }
    case 'attachment.delete': {
      const thread = find(getGenre().chat.threads, p.threadId, '会話'); find(thread.attachments, p.id, '添付資料'); thread.attachments = thread.attachments.filter(item => item.id !== p.id); touch(thread); break;
    }
    case 'chat.update': {
      const owner = p.genreId ? find(getGenre().chat.threads, p.threadId, '会話') : getProject().chat;
      const allowed = ['input', 'provider', 'model', 'directWriting'];
      for (const key of allowed) if (Object.hasOwn(p.changes || {}, key)) owner[key] = p.changes[key];
      break;
    }
    case 'settings.update': {
      for (const role of ['chat', 'writing', 'judgment', 'background']) if (p.roles?.[role]) next.settings.roles[role] = { ...next.settings.roles[role], ...p.roles[role] };
      break;
    }
    case 'layout.remember': {
      const descriptor = p.descriptor;
      if (!PANEL_TYPES.includes(descriptor?.type) || !descriptor.key) fail('INVALID', '分離対象が不正です。');
      next.layout.detached = next.layout.detached.filter(item => item.key !== descriptor.key);
      next.layout.detached.push(descriptor); break;
    }
    case 'layout.forget': next.layout.detached = next.layout.detached.filter(item => item.key !== p.key); break;
    case 'view.save': next.layout.viewState[p.key] = p.value; broadcast = false; break;
    default: fail('UNAVAILABLE', 'この操作は実アプリの接続が必要です。画面案で成功扱いにはしません。');
  }
  next.revision++;
  return { state: next, result, broadcast };
}
