use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Genre {
    pub schema_version: u32,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub user_definition: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub tags: Vec<String>,
    pub status: String,
    #[serde(default)]
    pub revision: u32,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenreIndexEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub status: String,
    #[serde(default)]
    pub revision: u32,
    #[serde(default)]
    pub source_count: usize,
    #[serde(default)]
    pub accepted_knowledge_count: usize,
    #[serde(default)]
    pub candidate_knowledge_count: usize,
    #[serde(default)]
    pub chat_thread_count: usize,
    pub created_at: String,
    pub updated_at: String,
}

impl GenreIndexEntry {
    pub fn from_genre(genre: &Genre) -> Self {
        Self {
            id: genre.id.clone(),
            name: genre.name.clone(),
            description: genre.description.clone(),
            status: genre.status.clone(),
            revision: genre.revision,
            source_count: 0,
            accepted_knowledge_count: 0,
            candidate_knowledge_count: 0,
            chat_thread_count: 0,
            created_at: genre.created_at.clone(),
            updated_at: genre.updated_at.clone(),
        }
    }
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenreIndex {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub genres: Vec<GenreIndexEntry>,
}

fn schema_version() -> u32 {
    SCHEMA_VERSION
}

#[derive(Default)]
pub struct GenreUpdate {
    pub name: Option<String>,
    pub aliases: Option<Vec<String>>,
    pub description: Option<String>,
    pub user_definition: Option<String>,
    pub notes: Option<String>,
    pub tags: Option<Vec<String>>,
    pub status: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenreSource {
    pub id: String,
    pub genre_id: String,
    pub title: String,
    #[serde(default)]
    pub author: String,
    pub source_type: String,
    pub source_role: String,
    pub preference: String,
    #[serde(default)]
    pub source_note: String,
    #[serde(default)]
    pub user_interpretation: String,
    pub media_type: String,
    pub language: String,
    pub content_file_name: String,
    pub content_hash: String,
    pub character_count: usize,
    pub segment_count: usize,
    pub analysis_status: String,
    pub latest_analysis_run_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceList {
    pub schema_version: u32,
    #[serde(default)]
    pub sources: Vec<GenreSource>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSegment {
    pub id: String,
    pub source_id: String,
    pub ordinal: usize,
    pub heading: String,
    pub start_offset: usize,
    pub end_offset: usize,
    pub content_hash: String,
    pub segmentation_method: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentDocument {
    pub schema_version: u32,
    pub source_id: String,
    #[serde(default)]
    pub segments: Vec<SourceSegment>,
}

pub struct SourceWithContent {
    pub metadata: GenreSource,
    pub content: String,
    pub segments: Vec<SourceSegment>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeCandidate {
    pub id: String,
    pub genre_id: String,
    pub category: String,
    pub title: String,
    pub statement: String,
    #[serde(default)]
    pub explanation: String,
    pub proposed_importance: String,
    pub status: String,
    #[serde(default)]
    pub confidence: f64,
    #[serde(default)]
    pub origin: String,
    #[serde(default)]
    pub source_references: Vec<serde_json::Value>,
    #[serde(default)]
    pub chat_references: Vec<serde_json::Value>,
    #[serde(default)]
    pub created_by: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeItem {
    pub id: String,
    pub genre_id: String,
    pub category: String,
    pub title: String,
    pub statement: String,
    #[serde(default)]
    pub explanation: String,
    pub importance: String,
    pub status: String,
    #[serde(default)]
    pub confidence: f64,
    pub authority: String,
    #[serde(default)]
    pub source_references: Vec<serde_json::Value>,
    #[serde(default)]
    pub chat_references: Vec<serde_json::Value>,
    pub created_from_candidate_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeDocument {
    pub schema_version: u32,
    pub genre_id: String,
    pub revision: u32,
    #[serde(default)]
    pub items: Vec<KnowledgeItem>,
    #[serde(default)]
    pub candidates: Vec<KnowledgeCandidate>,
    pub updated_at: String,
}
