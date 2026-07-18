use wasm_bindgen::JsValue;

use crate::runtime::ai;

use super::model::{Candidate, SourceFile};

pub async fn classify(file: &SourceFile, settings_only: bool) -> Candidate {
    match classify_with_ai(file, settings_only).await {
        Ok(candidate) => candidate,
        Err(error) => fallback(file, settings_only, &format!("{error:?}")),
    }
}

async fn classify_with_ai(file: &SourceFile, settings_only: bool) -> Result<Candidate, JsValue> {
    let valid = if settings_only {
        "character, world, relationship, ignore"
    } else {
        "character, world, episode, memo, projectMemo, relationship, ignore"
    };
    let content = sample(&file.content, 60_000);
    let prompt = format!(
        r#"次のファイルを創作支援アプリへ取り込むため分類してください。
有効な type: {valid}
設定のみモード: {settings_only}

必ず次の JSON オブジェクトだけを返してください。
{{"type":"episode","title":"日本語タイトル","reason":"日本語の分類理由","fields":{{}},"episodeTitle":null,"relationships":[]}}

character/world の fields には原文に明記された属性だけを入れてください。
character の主なキー: name, reading, alias, role, gender, age, appearance, personality, background, notes
world の主なキー: name, category, era, geography, politics, culture, history, technology, notes
relationship の relationships には、各関係を
{{"episodeTitle":"","characterAName":"人物A","characterBName":"人物B","direction":"bidirectional","description":"関係"}}
として列挙してください。direction は bidirectional, a-to-b, b-to-a のいずれかです。
原稿本文は episode、特定話の覚え書きは memo、作品全体のメモは projectMemo です。
設定のみモードでは原稿を episode にせず、永続的設定がなければ ignore にしてください。

path: {}
filename: {}
inferred title: {}

<source>
{}
</source>"#,
        file.path, file.filename, file.title, content
    );
    let output = ai::generate(
        "background",
        "You classify import files. Return strict JSON only.".into(),
        prompt,
    )
    .await?;
    let raw = json_object(&output.text)
        .ok_or_else(|| JsValue::from_str("AI classification did not contain JSON"))?;
    let mut candidate: Candidate = serde_json::from_str(raw)
        .map_err(|error| JsValue::from_str(&format!("invalid classification JSON: {error}")))?;
    normalize(&mut candidate, file, settings_only);
    Ok(candidate)
}

fn normalize(candidate: &mut Candidate, file: &SourceFile, settings_only: bool) {
    let allowed = if settings_only {
        ["character", "world", "relationship", "ignore"].as_slice()
    } else {
        [
            "character",
            "world",
            "episode",
            "memo",
            "projectMemo",
            "relationship",
            "ignore",
        ]
        .as_slice()
    };
    if !allowed.contains(&candidate.file_type.as_str()) {
        candidate.file_type = infer_type(&file.path, settings_only).into();
    }
    if candidate.title.trim().is_empty() {
        candidate.title = file.title.clone();
    }
}

fn fallback(file: &SourceFile, settings_only: bool, error: &str) -> Candidate {
    Candidate {
        file_type: infer_type(&file.path, settings_only).into(),
        title: file.title.clone(),
        reason: format!("AI分類に失敗したためファイル名から推定しました: {error}"),
        ..Default::default()
    }
}

fn infer_type(path: &str, settings_only: bool) -> &'static str {
    let text = path.to_lowercase();
    if contains(
        &text,
        &["character", "characters", "人物", "キャラ", "登場人物"],
    ) {
        "character"
    } else if contains(&text, &["relationship", "relation", "関係", "相関"]) {
        "relationship"
    } else if contains(&text, &["world", "setting", "lore", "世界", "設定", "用語"]) {
        "world"
    } else if settings_only {
        "ignore"
    } else if contains(&text, &["memo", "note", "メモ", "覚え書き"]) {
        "memo"
    } else if contains(&text, &["project", "作品", "全体", "企画"]) {
        "projectMemo"
    } else if contains(
        &text,
        &["episode", "chapter", "scene", "本文", "原稿", "第"],
    ) {
        "episode"
    } else {
        "ignore"
    }
}

fn contains(value: &str, candidates: &[&str]) -> bool {
    candidates.iter().any(|candidate| value.contains(candidate))
}

fn sample(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        value.into()
    } else {
        value.chars().take(limit).collect()
    }
}

fn json_object(value: &str) -> Option<&str> {
    let start = value.find('{')?;
    let end = value.rfind('}')?;
    (end >= start).then(|| &value[start..=end])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_fenced_json_object() {
        assert_eq!(
            json_object("```json\n{\"type\":\"world\"}\n```"),
            Some("{\"type\":\"world\"}")
        );
    }

    #[test]
    fn settings_only_never_falls_back_to_episode() {
        assert_eq!(infer_type("episodes/第1話.md", true), "ignore");
    }
}
