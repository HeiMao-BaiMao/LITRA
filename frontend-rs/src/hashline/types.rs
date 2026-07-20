//! hashline のコアデータ構造。ファイルシステムやランタイムに依存しない純粋な型。
//! oh-my-pi `packages/hashline/src/types.ts` の移植（小説編集向けにブロック操作を省略）。

/// 1-indexed の行アンカー。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Anchor {
    pub line: u32,
}

impl Anchor {
    pub fn new(line: u32) -> Self {
        Self { line }
    }
}

/// `insert` 編集の挿入位置。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Cursor {
    /// INS.HEAD — ファイル先頭。
    Bof,
    /// INS.TAIL — ファイル末尾。
    Eof,
    /// INS.PRE / SWAP ペイロードのアンカー（行の前）。
    BeforeAnchor { anchor: Anchor },
    /// INS.POST — 行の後。
    AfterAnchor { anchor: Anchor },
}

/// 解析済みの `[A.=B]` 行範囲（両端含む）。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ParsedRange {
    pub start: Anchor,
    pub end: Anchor,
}

/// 挿入モード。SWAP ペイロード由来の挿入は `Replacement`。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InsertMode {
    Replacement,
}

/// パーサが生成しアプライヤが消費する低レベル編集。
///
/// 複数行の SWAP は、ペイロード1行あたり1つの `Insert`（mode=Replacement）と、
/// 消費される各行1つの `Delete` に分解される。
#[derive(Clone, Debug)]
pub enum Edit {
    Insert {
        cursor: Cursor,
        text: String,
        /// この編集を生成した元パッチ行番号（診断・グループ化用）。
        line_num: u32,
        /// セクション全体を通した単調増加の出力順序。
        index: u32,
        /// SWAP ペイロード由来の挿入は Some(Replacement)。
        mode: Option<InsertMode>,
    },
    Delete {
        anchor: Anchor,
        line_num: u32,
        index: u32,
    },
}

/// 編集適用の結果。
#[derive(Clone, Debug)]
pub struct ApplyResult {
    /// 編集後の本文。
    pub text: String,
    /// 変更された最初の行番号（1-indexed）。no-op の場合は None。
    pub first_changed_line: Option<u32>,
    /// パーサ・パッチャ・リカバリが収集した警告。
    pub warnings: Vec<String>,
}

impl ApplyResult {
    pub fn unchanged(text: String) -> Self {
        Self {
            text,
            first_changed_line: None,
            warnings: Vec::new(),
        }
    }
}
