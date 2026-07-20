//! セッションごとのスナップショットストア。oh-my-pi `snapshots.ts` の移植。
//!
//! hashline セクションタグを、それを発行した正確なファイル内容に紐づける。
//! セクションタグはファイル全体の内容由来ハッシュ（[`compute_file_hash`] 参照）であり、
//! バイト同一の内容は何度読んでも同じタグになる。プロデューサ（read/search/write）は
//! 観察した正規化済み全文を [`InMemorySnapshotStore::record`] に渡し、コンシューマ
//! （recovery / patcher）は古くなったタグを記録済み全文へ解決し、その変更なし行を
//! ライブ内容へマップする。
//!
//! TS 版は抽象基底クラス + LRU キャッシュだが、ここでは具体型のインメモリストア
//! 1つに簡略化する（パス単位の短い版本履歴 + パス数の LRU 上限）。

use std::collections::{HashMap, HashSet};

use crate::hashline::format::compute_file_hash;

/// 追跡するパス数の上限（LRU 退去）。TS: `DEFAULT_MAX_PATHS`。
const DEFAULT_MAX_PATHS: usize = 30;
/// パスごとに保持する全文版本数の上限（古いものから落とす輪）。TS: `DEFAULT_MAX_VERSIONS_PER_PATH`。
const DEFAULT_MAX_VERSIONS_PER_PATH: usize = 4;

/// ある時点で観察された全文版本1つ。モデルに見えるタグは [`Snapshot::hash`]、
/// recovery が編集を再生するのは [`Snapshot::text`] に対して。
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    /// この版本が属する正規化パス。
    pub path: String,
    /// 観察されたままの正規化済み（LF, BOM なし）全文。
    pub text: String,
    /// [`Snapshot::text`] の内容由来タグ（[`compute_file_hash`] 参照）。
    pub hash: String,
    /// 版本が記録された時刻（epoch からのミリ秒）。
    pub recorded_at: f64,
    /// このタグでプロデューサが実際に *表示した* 1-indexed 行。部分読み取りは疎になり、
    /// 全文読み取りは全行を埋める。同一内容の複数読み取りは1つの集合へ和集合される。
    /// `None` は「来歴未記録」を意味し、パッチャは seen-line 検査をスキップする。
    pub seen_lines: Option<HashSet<u32>>,
}

/// `lines` を `snapshot.seen_lines` へ和集合する。集合を遅延生成する。
/// TS: `mergeSeenLines`。
fn merge_seen_lines(snapshot: &mut Snapshot, lines: Option<&[u32]>) {
    let Some(lines) = lines else {
        return;
    };
    let set = snapshot.seen_lines.get_or_insert_with(HashSet::new);
    for &line in lines {
        set.insert(line);
    }
}

/// インメモリのスナップショットストア。パスごとの履歴は全文版本の短い輪
/// （古いものから落とす）、パス管理は LRU 上限付きで冷えたパスから老化する。
///
/// バイト同一の内容を再度記録すると鮮度が更新され既存タグが再利用される（読み取り融合）。
/// 新しい内容を記録するとパス履歴の先頭に新しい版本が挿入される。短い4桁タグで衝突した
/// 2つの異なるテキストは別々の版本として保持され、呼び出し側は [`Snapshot::text`] で
/// 区別できる — タグは高速な索引に過ぎず、同一性そのものではない。
#[derive(Debug)]
pub struct InMemorySnapshotStore {
    /// path → 版本列（index 0 = 最新）。
    versions: HashMap<String, Vec<Snapshot>>,
    /// LRU 順序（index 0 = 最も最近使用）。`versions` のキーと同期を保つ。
    recency: Vec<String>,
    max_versions_per_path: usize,
    max_paths: usize,
}

impl Default for InMemorySnapshotStore {
    fn default() -> Self {
        Self::new()
    }
}

impl InMemorySnapshotStore {
    pub fn new() -> Self {
        Self {
            versions: HashMap::new(),
            recency: Vec::new(),
            max_versions_per_path: DEFAULT_MAX_VERSIONS_PER_PATH,
            max_paths: DEFAULT_MAX_PATHS,
        }
    }

    /// `path` の最も最近記録された版本。なければ `None`。
    pub fn head(&self, path: &str) -> Option<&Snapshot> {
        self.versions.get(path).and_then(|history| history.first())
    }

    /// `path` の版本のうちタグが `hash` に等しいもの（最新寄り）。なければ `None`。
    /// 16-bit タグで2つの異なるテキストが衝突した場合は最も最近記録されたものを返す。
    pub fn by_hash(&self, path: &str, hash: &str) -> Option<&Snapshot> {
        self.versions
            .get(path)
            .and_then(|history| history.iter().find(|version| version.hash == hash))
    }

    /// `path` の版本のうち [`Snapshot::text`] が `full_text` に等しいもの。なければ `None`。
    pub fn by_content(&self, path: &str, full_text: &str) -> Option<&Snapshot> {
        self.versions
            .get(path)
            .and_then(|history| history.iter().find(|version| version.text == full_text))
    }

    /// 全パスにわたりタグが `hash` に等しい保持版本すべて。
    pub fn find_by_hash(&self, hash: &str) -> Vec<&Snapshot> {
        let mut matches = Vec::new();
        for history in self.versions.values() {
            for version in history {
                if version.hash == hash {
                    matches.push(version);
                }
            }
        }
        matches
    }

    /// `path` の正規化済み全文を記録し、その内容タグを返す。
    /// `seen_lines`（任意）はプロデューサが表示した 1-indexed 行。同一テキストの
    /// 読み取りをまたいで [`Snapshot::seen_lines`] へ和集合される。
    pub fn record(&mut self, path: &str, full_text: &str, seen_lines: Option<&[u32]>) -> String {
        let hash = compute_file_hash(full_text);
        let now = js_sys::Date::now();
        let max_versions = self.max_versions_per_path;
        {
            let history = self.versions.entry(path.to_string()).or_default();
            // 重複排除はタグ一致ではなく全文一致を要する: タグを共有する2つの異なる
            // テキストは別スナップショットであり、融合すると seen_lines を汚損する。
            if let Some(pos) = history
                .iter()
                .position(|version| version.hash == hash && version.text == full_text)
            {
                // 同じ内容状態を再観察: 鮮度を更新し先頭へ昇格、タグを再利用。
                history[pos].recorded_at = now;
                merge_seen_lines(&mut history[pos], seen_lines);
                if pos != 0 {
                    let snapshot = history.remove(pos);
                    history.insert(0, snapshot);
                }
            } else {
                let mut snapshot = Snapshot {
                    path: path.to_string(),
                    text: full_text.to_string(),
                    hash: hash.clone(),
                    recorded_at: now,
                    seen_lines: None,
                };
                merge_seen_lines(&mut snapshot, seen_lines);
                history.insert(0, snapshot);
                history.truncate(max_versions);
            }
        }
        self.touch(path);
        self.evict_if_needed();
        hash
    }

    /// タグが `hash` の版本の [`Snapshot::seen_lines`] へ `lines` を和集合する。
    /// そのような版本が保持されていない場合は no-op。
    pub fn record_seen_lines(&mut self, path: &str, hash: &str, lines: &[u32]) {
        if let Some(history) = self.versions.get_mut(path) {
            if let Some(version) = history.iter_mut().find(|version| version.hash == hash) {
                merge_seen_lines(version, Some(lines));
            }
        }
    }

    /// 単一パスの版本履歴を破棄する。
    pub fn invalidate(&mut self, path: &str) {
        self.versions.remove(path);
        self.recency.retain(|p| p != path);
    }

    /// 保持版本履歴（と読み取り来歴）を `from` から `to` へ移動する。`from` に履歴が
    /// なければ no-op。ファイル移動で、ソースパスの読み取りが発行したタグを移動先でも
    /// 有効に保つために使う。ハッシュごとの併合は「先頭優先（relocated 優先）」。
    pub fn relocate(&mut self, from: &str, to: &str) {
        let source = match self.versions.get(from) {
            Some(history) if !history.is_empty() => history.clone(),
            _ => return,
        };
        let relocated: Vec<Snapshot> = source
            .into_iter()
            .map(|mut version| {
                version.path = to.to_string();
                version
            })
            .collect();
        let dest = self.versions.get(to).cloned();
        let max_versions = self.max_versions_per_path;
        let merged = match dest {
            None => relocated,
            Some(dest_history) => {
                let mut seen = HashSet::new();
                let mut out = Vec::new();
                for version in relocated.into_iter().chain(dest_history.into_iter()) {
                    if seen.contains(&version.hash) {
                        continue;
                    }
                    seen.insert(version.hash.clone());
                    out.push(version);
                }
                out.truncate(max_versions);
                out
            }
        };
        self.versions.remove(from);
        self.versions.insert(to.to_string(), merged);
        self.recency.retain(|p| p != from);
        self.touch(to);
    }

    /// すべての版本履歴を破棄する。
    pub fn clear(&mut self) {
        self.versions.clear();
        self.recency.clear();
    }

    /// `path` を LRU 順序の先頭（最も最近）へ移動する。
    fn touch(&mut self, path: &str) {
        self.recency.retain(|p| p != path);
        self.recency.insert(0, path.to_string());
    }

    /// パス数が上限を超えていたら、最も古いパスから退去する。
    fn evict_if_needed(&mut self) {
        while self.versions.len() > self.max_paths {
            let victim = self
                .recency
                .pop()
                .or_else(|| self.versions.keys().next().cloned());
            match victim {
                Some(path) => {
                    self.versions.remove(&path);
                }
                None => break,
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_and_resolve_by_hash_and_head() {
        let mut store = InMemorySnapshotStore::new();
        let tag = store.record("f.txt", "hello\nworld", Some(&[1, 2]));
        assert_eq!(tag, compute_file_hash("hello\nworld"));
        let snap = store.by_hash("f.txt", &tag).expect("by_hash should find it");
        assert_eq!(snap.text, "hello\nworld");
        assert_eq!(store.head("f.txt").expect("head").hash, tag);
        let seen = snap.seen_lines.as_ref().expect("seen_lines recorded");
        assert!(seen.contains(&1) && seen.contains(&2));
    }

    #[test]
    fn dedup_refreshes_and_merges_seen_lines() {
        let mut store = InMemorySnapshotStore::new();
        let tag = store.record("f.txt", "a\nb", Some(&[1]));
        store.record("f.txt", "a\nb", Some(&[2]));
        // 同一内容は1版本に融合される。
        assert_eq!(store.find_by_hash(&tag).len(), 1);
        let snap = store.by_content("f.txt", "a\nb").expect("by_content");
        let seen = snap.seen_lines.as_ref().expect("seen_lines");
        assert!(seen.contains(&1) && seen.contains(&2));
    }

    #[test]
    fn truncates_to_max_versions_per_path() {
        let mut store = InMemorySnapshotStore::new();
        for i in 0..6u32 {
            store.record("f.txt", &format!("content {i}"), None);
        }
        // 最新は content 5、保持は最新4件（content 2..=5）。
        assert_eq!(store.head("f.txt").expect("head").text, "content 5");
        assert!(store.by_content("f.txt", "content 0").is_none());
        assert!(store.by_content("f.txt", "content 1").is_none());
        assert!(store.by_content("f.txt", "content 2").is_some());
    }

    #[test]
    fn invalidate_and_clear() {
        let mut store = InMemorySnapshotStore::new();
        store.record("a.txt", "x", None);
        store.record("b.txt", "y", None);
        store.invalidate("a.txt");
        assert!(store.head("a.txt").is_none());
        assert!(store.head("b.txt").is_some());
        store.clear();
        assert!(store.head("b.txt").is_none());
    }

    #[test]
    fn relocate_moves_history_and_rebinds_path() {
        let mut store = InMemorySnapshotStore::new();
        let tag = store.record("old.txt", "shared\ncontent", None);
        store.relocate("old.txt", "new.txt");
        assert!(store.head("old.txt").is_none());
        let snap = store.by_hash("new.txt", &tag).expect("relocated version");
        assert_eq!(snap.path, "new.txt");
        assert_eq!(snap.text, "shared\ncontent");
    }
}
