pub mod cache_observability;
pub mod capability;
pub mod draft_checks;
pub mod plan_beats;
pub mod provider_options;
pub mod role_settings;
pub mod structured_output;
pub mod style_fingerprint;
pub mod text_stats;

use serde::Serialize;

/// 文体指紋の計測結果。
/// TypeScript `StyleFingerprint` に相当。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleFingerprint {
    /// 1文の平均文字数（句点区切り）
    pub average_sentence_length: f64,
    /// 本文に占める漢字の割合 0〜1
    pub kanji_ratio: f64,
    /// 会話行（「で始まる行）の割合 0〜1
    pub dialogue_ratio: f64,
    /// 1段落あたりの平均文数
    pub average_sentences_per_paragraph: f64,
    /// 地の文の文末表現の分布（頻度順）
    pub sentence_endings: Vec<SentenceEndingEntry>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SentenceEndingEntry {
    pub form: String,
    pub ratio: f64,
}

/// ドラフト機械検査の結果。
/// TypeScript `DraftCheckFindings` に相当。
#[derive(Clone, Debug)]
pub struct DraftCheckFindings {
    /// 破棄すべき重大違反
    pub hard: Vec<String>,
    /// 査読で修正可能な軽微違反
    pub soft: Vec<String>,
}
