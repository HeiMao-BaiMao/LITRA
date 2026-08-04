//! hashline: コンパクトな行アンカー付きパッチ言語とアプライヤ。
//!
//! oh-my-pi `@oh-my-pi/hashline` の Rust 移植（小説編集向けに tree-sitter
//! ブロック操作とコード固有の修復を省略）。
//!
//! 核心の考え方:
//! - 各ファイルセクションは `[PATH#TAG]` ヘッダを持ち、TAG = ファイル全体の
//!   内容ハッシュ（4桁16進）。スナップショットを証明し、ドリフトを検出する。
//! - 行番号は元ファイルを参照し、ハーク適用はボトムアップで行われるため番号はずれない。
//! - seen-line ガード: read で表示していない行への編集は拒否される。
//! - タグ不一致時は3-way ラインマージでアンカーをリマップして回復を試みる。
//!
//! このモジュールは oh-my-pi hashline ライブラリの自己完結的な移植であり、公開 API の
//! 一部（ヘッダ整形ヘルパ、PatchSection のアクセサ、ストアの invalidate/relocate 等）は
//! 現在の LITRA 統合では未消費だが、ライブラリの完全な API 表面として保持している
//! （ユニットテストや将来の拡張で使用）。そのため dead_code 警告を抑止する。
#![allow(dead_code)]

pub mod apply;
pub mod format;
pub mod input;
pub mod messages;
pub mod mismatch;
pub mod normalize;
pub mod parser;
pub mod patcher;
pub mod recovery;
pub mod snapshots;
pub mod tokenizer;
pub mod types;
