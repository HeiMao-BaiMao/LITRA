//! AI プロンプトキャッシュの可観測性。
//! キャッシュヒット率をステップ・プロバイダ・モデルごとに記録・永続化する。
//!
//! TypeScript `cache-observability.ts` の Rust 移植。
#![allow(dead_code)]

use std::cell::RefCell;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use wasm_bindgen::JsValue;

use crate::runtime::invoke;

const CACHE_FILE: &str = "ai-cache-observability.json";
const SCHEMA_VERSION: u32 = 1;
const MAX_STATS: usize = 5000;
const MAX_ARTIFACTS: usize = 500;

thread_local! {
    static ACTIVE_PROJECT: RefCell<Option<String>> = const { RefCell::new(None) };
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiCacheStat {
    pub timestamp: String,
    pub step: String,
    pub provider: String,
    pub model: String,
    pub prompt_cache_hit_tokens: u64,
    pub prompt_cache_miss_tokens: u64,
    pub hit_rate: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedArtifact {
    key: String,
    hash: String,
    value: String,
    #[serde(rename = "updatedAt")]
    updated_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheDocument {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    stats: Vec<AiCacheStat>,
    artifacts: Vec<CachedArtifact>,
}

impl Default for CacheDocument {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            stats: Vec::new(),
            artifacts: Vec::new(),
        }
    }
}

/// アクティブなプロジェクト ID を設定する。
pub fn set_ai_cache_project(project_id: Option<String>) {
    ACTIVE_PROJECT.with(|p| *p.borrow_mut() = project_id);
}

fn file_path(project_id: &str) -> String {
    format!("litra/projects/{project_id}/{CACHE_FILE}")
}

async fn load_document(project_id: &str) -> CacheDocument {
    let result: Result<Value, JsValue> =
        invoke::invoke("project_read_document", &serde_json::json!({
            "projectId": project_id,
            "documentKind": "ai-cache-observability",
        }))
        .await;

    match result {
        Ok(v) => {
            let mut doc: CacheDocument =
                serde_json::from_value(v).unwrap_or_default();
            if doc.schema_version == 0 {
                doc.schema_version = SCHEMA_VERSION;
            }
            doc
        }
        Err(_) => CacheDocument::default(),
    }
}

async fn save_document(project_id: &str, document: &CacheDocument) {
    let json = serde_json::to_value(document).unwrap_or_default();
    let _: Result<Value, JsValue> = invoke::invoke(
        "project_write_document",
        &serde_json::json!({
            "projectId": project_id,
            "documentKind": "ai-cache-observability",
            "content": json,
        }),
    )
    .await;
}

async fn mutate_document(
    project_id: &str,
    mutate: impl FnOnce(&mut CacheDocument),
) {
    let mut document = load_document(project_id).await;
    mutate(&mut document);
    save_document(project_id, &document).await;
}

fn finite_token_count(value: &Value) -> Option<u64> {
    value.as_u64().filter(|&v| v > 0)
}

/// DeepSeek の providerMetadata からキャッシュトークン情報を抽出する。
pub fn extract_deepseek_cache_tokens(
    provider_metadata: &Value,
) -> Option<(u64, u64)> {
    let deepseek = provider_metadata.get("deepseek")?;
    let hit = finite_token_count(deepseek.get("promptCacheHitTokens")?)?;
    let miss = finite_token_count(deepseek.get("promptCacheMissTokens")?)?;
    Some((hit, miss))
}

/// プロバイダのキャッシュ使用量を記録する。
///
/// `step` は "draft" / "review" / "continuation" などの工程名。
/// `provider` / `model` は使用中のプロバイダ情報。
/// `provider_metadata` は AI レスポンスの providerMetadata。
pub async fn record_provider_cache_usage(
    step: &str,
    provider: &str,
    model: &str,
    provider_metadata: &Value,
) {
    let Some((hit, miss)) = extract_deepseek_cache_tokens(provider_metadata) else {
        return;
    };
    let total = hit + miss;
    let stat = AiCacheStat {
        timestamp: chrono_now(),
        step: step.to_string(),
        provider: provider.to_string(),
        model: model.to_string(),
        prompt_cache_hit_tokens: hit,
        prompt_cache_miss_tokens: miss,
        hit_rate: if total > 0 {
            hit as f64 / total as f64
        } else {
            0.0
        },
    };

    let project_id = ACTIVE_PROJECT.with(|p| p.borrow().clone());
    let Some(project_id) = project_id else { return };

    let _ = mutate_document(&project_id, |doc| {
        doc.stats.push(stat);
        doc.stats.truncate(MAX_STATS);
    })
    .await;
}

/// 永続化された AI 生成物を読み込む。
pub async fn load_persistent_ai_artifact(
    key: &str,
    hash: &str,
) -> Option<String> {
    let project_id = ACTIVE_PROJECT.with(|p| p.borrow().clone())?;
    let document = load_document(&project_id).await;
    document
        .artifacts
        .iter()
        .find(|a| a.key == key && a.hash == hash)
        .map(|a| a.value.clone())
}

/// AI 生成物を永続化する。
pub async fn save_persistent_ai_artifact(
    key: &str,
    hash: &str,
    value: &str,
) {
    let project_id = ACTIVE_PROJECT.with(|p| p.borrow().clone());
    let Some(project_id) = project_id else { return };

    let now = chrono_now();
    let _ = mutate_document(&project_id, |doc| {
        doc.artifacts.retain(|a| a.key != key);
        doc.artifacts.insert(
            0,
            CachedArtifact {
                key: key.to_string(),
                hash: hash.to_string(),
                value: value.to_string(),
                updated_at: now,
            },
        );
        doc.artifacts.truncate(MAX_ARTIFACTS);
    })
    .await;
}

fn chrono_now() -> String {
    // ISO 8601 timestamp in local time (simplified: UTC)
    let now = js_sys::Date::new_0();
    now.to_iso_string().as_string().unwrap_or_default()
}

/// キャッシュ統計を読み込む（デバッグ・表示用）。
pub async fn load_cache_stats(project_id: &str) -> Vec<AiCacheStat> {
    load_document(project_id).await.stats
}
