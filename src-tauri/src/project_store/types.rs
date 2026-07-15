use serde::{Deserialize, Serialize};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub title: String,
    pub updated_at: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Episode {
    pub id: String,
    pub title: String,
    pub order: usize,
    pub file_name: String,
}

#[derive(Default, Deserialize, Serialize)]
pub struct EpisodeList {
    #[serde(default)]
    pub episodes: Vec<Episode>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProjectDocumentKind {
    Chat,
    Summaries,
    Memos,
}

impl ProjectDocumentKind {
    pub fn file_name(self) -> &'static str {
        match self {
            Self::Chat => "chat.json",
            Self::Summaries => "summaries.json",
            Self::Memos => "memos.json",
        }
    }
}
