use crate::storage::{project_dir, project_search_index_dir as index_dir, read_json};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::{Schema, Value, STORED, TEXT};
use tantivy::snippet::SnippetGenerator;
use tantivy::{Index, IndexWriter, ReloadPolicy, TantivyDocument};

const DEFAULT_LIMIT: usize = 5;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub score: f32,
    pub episode_id: String,
    pub title: String,
    pub doc_type: String,
    pub snippet: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RebuildResult {
    pub success: bool,
    pub message: String,
    pub indexed_documents: usize,
}

fn build_schema() -> Schema {
    let mut builder = Schema::builder();
    builder.add_text_field("id", TEXT | STORED);
    builder.add_text_field("episode_id", TEXT | STORED);
    builder.add_text_field("title", TEXT | STORED);
    builder.add_text_field("doc_type", TEXT | STORED);
    builder.add_text_field("content", TEXT);
    builder.build()
}

fn open_index_writer(project_id: &str, recreate: bool) -> Result<(Index, IndexWriter), String> {
    let dir = index_dir(project_id)?;

    if recreate && dir.exists() {
        fs::remove_dir_all(&dir).map_err(|e| format!("Failed to remove old index: {}", e))?;
    }
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create index directory: {}", e))?;

    let schema = build_schema();
    let index = if recreate || !dir.join("meta.json").exists() {
        Index::create_in_dir(&dir, schema).map_err(|e| format!("Failed to create index: {}", e))?
    } else {
        Index::open_in_dir(&dir).map_err(|e| format!("Failed to open index: {}", e))?
    };

    let writer = index
        .writer(50_000_000)
        .map_err(|e| format!("Failed to create index writer: {}", e))?;

    Ok((index, writer))
}

#[tauri::command]
pub fn rebuild_search_index(project_id: String) -> Result<RebuildResult, String> {
    let episodes_path = project_dir(&project_id)?.join("episodes.json");
    let episodes = read_json(&episodes_path)?;
    let episode_array = episodes["episodes"]
        .as_array()
        .ok_or_else(|| "Invalid episodes list".to_string())?;

    let summaries_path = project_dir(&project_id)?.join("summaries.json");
    let summaries = if summaries_path.exists() {
        read_json(&summaries_path).unwrap_or_else(|_| json!({ "summaries": {} }))
    } else {
        json!({ "summaries": {} })
    };

    let (index, mut index_writer) = open_index_writer(&project_id, true)?;
    let schema = index.schema();
    let id_field = schema
        .get_field("id")
        .map_err(|e| format!("Schema field 'id' not found: {}", e))?;
    let episode_id_field = schema
        .get_field("episode_id")
        .map_err(|e| format!("Schema field 'episode_id' not found: {}", e))?;
    let title_field = schema
        .get_field("title")
        .map_err(|e| format!("Schema field 'title' not found: {}", e))?;
    let doc_type_field = schema
        .get_field("doc_type")
        .map_err(|e| format!("Schema field 'doc_type' not found: {}", e))?;
    let content_field = schema
        .get_field("content")
        .map_err(|e| format!("Schema field 'content' not found: {}", e))?;

    let mut indexed = 0usize;
    for ep in episode_array {
        let ep_id = ep["id"].as_str().unwrap_or_default();
        let title = ep["title"].as_str().unwrap_or_default();
        let file_name = ep["fileName"].as_str().unwrap_or_default();

        let file_path = project_dir(&project_id)?.join("episodes").join(file_name);
        let full_text = fs::read_to_string(&file_path).unwrap_or_default();
        let normalized = full_text.replace("\r\n", "\n");
        if !normalized.is_empty() {
            let mut doc = TantivyDocument::default();
            doc.add_text(id_field, &format!("{}-fullText", ep_id));
            doc.add_text(episode_id_field, ep_id);
            doc.add_text(title_field, title);
            doc.add_text(doc_type_field, "fullText");
            doc.add_text(content_field, &normalized);
            index_writer
                .add_document(doc)
                .map_err(|e| format!("Failed to add document: {}", e))?;
            indexed += 1;
        }

        let summary = summaries["summaries"][ep_id]["content"]
            .as_str()
            .unwrap_or_default();
        if !summary.is_empty() {
            let mut doc = TantivyDocument::default();
            doc.add_text(id_field, &format!("{}-summary", ep_id));
            doc.add_text(episode_id_field, ep_id);
            doc.add_text(title_field, title);
            doc.add_text(doc_type_field, "summary");
            doc.add_text(content_field, summary);
            index_writer
                .add_document(doc)
                .map_err(|e| format!("Failed to add document: {}", e))?;
            indexed += 1;
        }
    }

    index_writer
        .commit()
        .map_err(|e| format!("Failed to commit index: {}", e))?;

    Ok(RebuildResult {
        success: true,
        message: format!("検索インデックスを再構築しました（{}件）。", indexed),
        indexed_documents: indexed,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    pub project_id: String,
    pub query: String,
    pub limit: Option<usize>,
}

#[tauri::command]
pub fn search_episodes(req: SearchRequest) -> Result<Vec<SearchResult>, String> {
    let dir = index_dir(&req.project_id)?;
    if !dir.exists() || !dir.join("meta.json").exists() {
        rebuild_search_index(req.project_id.clone())?;
    }

    let index =
        Index::open_in_dir(&dir).map_err(|e| format!("Failed to open search index: {}", e))?;
    let schema = index.schema();
    let content_field = schema
        .get_field("content")
        .map_err(|e| format!("Schema field 'content' not found: {}", e))?;
    let title_field = schema
        .get_field("title")
        .map_err(|e| format!("Schema field 'title' not found: {}", e))?;

    let reader = index
        .reader_builder()
        .reload_policy(ReloadPolicy::OnCommitWithDelay)
        .try_into()
        .map_err(|e| format!("Failed to create index reader: {}", e))?;
    let searcher = reader.searcher();

    let query_parser = QueryParser::for_index(&index, vec![content_field, title_field]);
    let parsed_query = query_parser
        .parse_query(&req.query)
        .map_err(|e| format!("Failed to parse query: {}", e))?;

    let limit = req.limit.unwrap_or(DEFAULT_LIMIT).min(50);
    let top_docs = searcher
        .search(&parsed_query, &TopDocs::with_limit(limit))
        .map_err(|e| format!("Failed to search index: {}", e))?;

    let snippet_generator = SnippetGenerator::create(&searcher, &*parsed_query, content_field)
        .map_err(|e| format!("Failed to create snippet generator: {}", e))?;

    let episode_id_field = schema
        .get_field("episode_id")
        .map_err(|e| format!("Schema field 'episode_id' not found: {}", e))?;
    let doc_type_field = schema
        .get_field("doc_type")
        .map_err(|e| format!("Schema field 'doc_type' not found: {}", e))?;

    let mut results = Vec::new();
    for (score, doc_address) in top_docs {
        let doc: TantivyDocument = searcher
            .doc(doc_address)
            .map_err(|e| format!("Failed to retrieve document: {}", e))?;

        let get_text = |field| {
            doc.get_first(field)
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string()
        };

        let snippet = snippet_generator.snippet_from_doc(&doc).to_html();

        results.push(SearchResult {
            score,
            episode_id: get_text(episode_id_field),
            title: get_text(title_field),
            doc_type: get_text(doc_type_field),
            snippet,
        });
    }

    Ok(results)
}
