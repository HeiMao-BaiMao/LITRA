use wasm_bindgen::JsValue;

use crate::runtime::ai;

use super::prompts;

pub async fn choose(first: &str, second: &str) -> Result<bool, JsValue> {
    let result = ai::generate(
        "judgment",
        "あなたは日本語小説の選考者です。指定された一文字以外を出力しないでください。".into(),
        prompts::select(first, second),
    )
    .await?;
    Ok(result.text.trim_start().starts_with('2'))
}

pub async fn inspect(context: &str, draft: &str) -> Result<String, JsValue> {
    ai::generate(
        "judgment",
        "あなたは小説の品質管理編集者です。本文にない事実を補わず、具体的な問題だけを日本語で指摘してください。".into(),
        prompts::review(context, draft),
    )
    .await
    .map(|result| result.text)
}

pub async fn prefer_revision(
    context: &str,
    original: &str,
    revised: &str,
) -> Result<bool, JsValue> {
    let result = ai::generate(
        "judgment",
        "あなたは小説改稿の回帰判定者です。指定された一文字以外を出力しないでください。".into(),
        prompts::regression(context, original, revised),
    )
    .await?;
    Ok(result.text.trim_start().starts_with('2'))
}
