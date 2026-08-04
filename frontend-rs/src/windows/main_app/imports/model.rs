use std::collections::HashMap;

use serde::{Deserialize, Serialize};

#[derive(Clone)]
pub struct SourceFile {
    pub path: String,
    pub filename: String,
    pub title: String,
    pub content: String,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Candidate {
    #[serde(rename = "type")]
    pub file_type: String,
    pub title: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub fields: HashMap<String, String>,
    #[serde(default)]
    pub episode_title: Option<String>,
    #[serde(default)]
    pub relationships: Vec<Relationship>,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Relationship {
    pub episode_title: String,
    pub character_a_name: String,
    pub character_b_name: String,
    pub direction: String,
    pub description: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportFile {
    pub path: String,
    pub filename: String,
    #[serde(rename = "type")]
    pub file_type: String,
    pub title: String,
    pub content: String,
    pub fields: HashMap<String, String>,
    pub episode_title: Option<String>,
    pub relationships: Vec<Relationship>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub characters: usize,
    pub world_entries: usize,
    pub episodes: usize,
    pub memos: usize,
    pub skipped_memos: usize,
    pub project_memos: usize,
    pub relationships: usize,
    pub skipped_relationships: usize,
}
