use crate::storage::{genre_dir, genre_search_index_dir as index_dir, read_json};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use tantivy::collector::TopDocs;
use tantivy::query::QueryParser;
use tantivy::schema::{Schema, Value, STORED, TEXT};
use tantivy::snippet::SnippetGenerator;
use tantivy::{Index, IndexWriter, ReloadPolicy, TantivyDocument};

const DEFAULT_LIMIT: usize = 10;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenreSearchResult {
    pub score: f32,
    pub genre_id: String,
    pub doc_id: String,
    pub doc_type: String,
    pub title: String,
    pub snippet: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenreRebuildResult {
    pub success: bool,
    pub message: String,
    pub indexed_documents: usize,
}

fn build_schema() -> Schema {
    let mut builder = Schema::builder();
    builder.add_text_field("id", TEXT | STORED);
    builder.add_text_field("genre_id", TEXT | STORED);
    builder.add_text_field("doc_type", TEXT | STORED);
    builder.add_text_field("title", TEXT | STORED);
    builder.add_text_field("content", TEXT);
    builder.build()
}

fn open_index_writer(genre_id: &str, recreate: bool) -> Result<(Index, IndexWriter), String> {
    let dir = index_dir(genre_id)?;

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
pub fn rebuild_genre_search_index(genre_id: String) -> Result<GenreRebuildResult, String> {
    let base = genre_dir(&genre_id)?;

    let sources_path = base.join("sources").join("index.json");
    let sources = if sources_path.exists() {
        read_json(&sources_path).unwrap_or_else(|_| json!({ "sources": [] }))
    } else {
        json!({ "sources": [] })
    };

    let knowledge_path = base.join("knowledge").join("current.json");
    let knowledge = if knowledge_path.exists() {
        read_json(&knowledge_path).unwrap_or_else(|_| json!({ "items": [], "candidates": [] }))
    } else {
        json!({ "items": [], "candidates": [] })
    };

    let (index, mut index_writer) = open_index_writer(&genre_id, true)?;
    let schema = index.schema();
    let id_field = schema
        .get_field("id")
        .map_err(|e| format!("Schema field 'id' not found: {}", e))?;
    let genre_id_field = schema
        .get_field("genre_id")
        .map_err(|e| format!("Schema field 'genre_id' not found: {}", e))?;
    let doc_type_field = schema
        .get_field("doc_type")
        .map_err(|e| format!("Schema field 'doc_type' not found: {}", e))?;
    let title_field = schema
        .get_field("title")
        .map_err(|e| format!("Schema field 'title' not found: {}", e))?;
    let content_field = schema
        .get_field("content")
        .map_err(|e| format!("Schema field 'content' not found: {}", e))?;

    let mut indexed = 0usize;

    for source in sources["sources"].as_array().unwrap_or(&Vec::new()) {
        let source_id = source["id"].as_str().unwrap_or_default();
        let title = source["title"].as_str().unwrap_or_default();

        // ソース本文は sources/{source_id}.md に保存されている
        let content_path = base.join("sources").join(format!("{}.md", source_id));
        let content = if content_path.exists() {
            fs::read_to_string(&content_path).unwrap_or_default()
        } else {
            String::new()
        };

        if !content.trim().is_empty() {
            let mut doc = TantivyDocument::default();
            doc.add_text(id_field, format!("source-{}-fullText", source_id));
            doc.add_text(genre_id_field, &genre_id);
            doc.add_text(doc_type_field, "source");
            doc.add_text(title_field, title);
            doc.add_text(content_field, &content);
            index_writer
                .add_document(doc)
                .map_err(|e| format!("Failed to add document: {}", e))?;
            indexed += 1;
        }

        // 分析結果は analyses/{run_id}.json に保存され、analyses/index.json で管理される
        // ソースの latestAnalysisRunId から最新の分析を参照する
        let run_id = source["latestAnalysisRunId"].as_str();
        if let Some(run_id) = run_id {
            let analysis_path = base
                .join("analyses")
                .join(format!("{}.json", run_id));
            if analysis_path.exists() {
                if let Ok(analysis) = read_json(&analysis_path) {
                    let summary = analysis["synthesis"]["sourceSummary"]
                        .as_str()
                        .unwrap_or_default();
                    if !summary.is_empty() {
                        let mut doc = TantivyDocument::default();
                        doc.add_text(id_field, format!("source-{}-analysis", source_id));
                        doc.add_text(genre_id_field, &genre_id);
                        doc.add_text(doc_type_field, "analysis");
                        doc.add_text(title_field, format!("{} の分析", title));
                        doc.add_text(content_field, summary);
                        index_writer
                            .add_document(doc)
                            .map_err(|e| format!("Failed to add document: {}", e))?;
                        indexed += 1;
                    }
                }
            }
        }
    }

    for item in knowledge["items"].as_array().unwrap_or(&Vec::new()) {
        let item_id = item["id"].as_str().unwrap_or_default();
        let title = item["title"].as_str().unwrap_or_default();
        let statement = item["statement"].as_str().unwrap_or_default();
        let explanation = item["explanation"].as_str().unwrap_or_default();
        let status = item["status"].as_str().unwrap_or_default();
        if status != "active" {
            continue;
        }

        let content = format!("{}\n{}", statement, explanation);
        if !content.trim().is_empty() {
            let mut doc = TantivyDocument::default();
            doc.add_text(id_field, format!("knowledge-{}", item_id));
            doc.add_text(genre_id_field, &genre_id);
            doc.add_text(doc_type_field, "knowledge");
            doc.add_text(title_field, title);
            doc.add_text(content_field, &content);
            index_writer
                .add_document(doc)
                .map_err(|e| format!("Failed to add document: {}", e))?;
            indexed += 1;
        }
    }

    index_writer
        .commit()
        .map_err(|e| format!("Failed to commit index: {}", e))?;

    Ok(GenreRebuildResult {
        success: true,
        message: format!(
            "ジャンル検索インデックスを再構築しました（{}件）。",
            indexed
        ),
        indexed_documents: indexed,
    })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenreSearchRequest {
    pub genre_id: String,
    pub query: String,
    pub limit: Option<usize>,
}

#[tauri::command]
pub fn search_genre(req: GenreSearchRequest) -> Result<Vec<GenreSearchResult>, String> {
    let dir = index_dir(&req.genre_id)?;
    if !dir.exists() || !dir.join("meta.json").exists() {
        rebuild_genre_search_index(req.genre_id.clone())?;
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
        .search(&parsed_query, &TopDocs::with_limit(limit).order_by_score())
        .map_err(|e| format!("Failed to search index: {}", e))?;

    let snippet_generator = SnippetGenerator::create(&searcher, &*parsed_query, content_field)
        .map_err(|e| format!("Failed to create snippet generator: {}", e))?;

    let id_field = schema
        .get_field("id")
        .map_err(|e| format!("Schema field 'id' not found: {}", e))?;
    let genre_id_field = schema
        .get_field("genre_id")
        .map_err(|e| format!("Schema field 'genre_id' not found: {}", e))?;
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

        results.push(GenreSearchResult {
            score,
            genre_id: get_text(genre_id_field),
            doc_id: get_text(id_field),
            doc_type: get_text(doc_type_field),
            title: get_text(title_field),
            snippet,
        });
    }

    Ok(results)
}
