mod classify;
mod model;
mod render;
mod review;

use std::{cell::RefCell, rc::Rc};

use js_sys::Promise;
use serde::Serialize;
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use web_sys::{Document, HtmlInputElement, HtmlSelectElement};

use super::State;
use crate::runtime::invoke;
use model::{Candidate, ImportFile, ImportResult, SourceFile};

#[derive(Default)]
pub struct ImportState {
    files: Vec<SourceFile>,
    candidates: Vec<Candidate>,
    settings_only: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImportArgs<'a> {
    project_id: &'a str,
    files: &'a [ImportFile],
}

pub fn choose_folder(document: &Document) -> Result<(), JsValue> {
    let input = document
        .get_element_by_id("folder-import-input")
        .and_then(|item| item.dyn_into::<HtmlInputElement>().ok())
        .ok_or_else(|| JsValue::from_str("folder import input is missing"))?;
    input.set_value("");
    input.click();
    Ok(())
}

pub async fn files_selected(
    document: &Document,
    state: &Rc<RefCell<State>>,
) -> Result<(), JsValue> {
    let input = document
        .get_element_by_id("folder-import-input")
        .and_then(|item| item.dyn_into::<HtmlInputElement>().ok())
        .ok_or_else(|| JsValue::from_str("folder import input is missing"))?;
    let Some(files) = input.files() else {
        return Ok(());
    };
    if files.length() == 0 {
        return Ok(());
    }
    let settings_only = mode(document);
    render::loading(document, "ファイルを読み込んでいます…")?;
    let mut sources = Vec::new();
    for index in 0..files.length() {
        let Some(file) = files.get(index) else {
            continue;
        };
        let filename = file.name();
        if !is_text_file(&filename) {
            continue;
        }
        let path = {
            let relative = js_sys::Reflect::get(&file, &JsValue::from_str("webkitRelativePath"))
                .ok()
                .and_then(|value| value.as_string())
                .unwrap_or_default();
            if relative.is_empty() {
                filename.clone()
            } else {
                relative
            }
        };
        let content = JsFuture::from(Promise::from(file.text()))
            .await?
            .as_string()
            .unwrap_or_default();
        sources.push(SourceFile {
            title: filename
                .trim_end_matches(".md")
                .trim_end_matches(".txt")
                .trim_end_matches(".csv")
                .to_owned(),
            path,
            filename,
            content,
        });
    }
    {
        let mut current = state.borrow_mut();
        current.import.files = sources;
        current.import.settings_only = settings_only;
        current.import.candidates.clear();
    }
    classify_all(document, state).await
}

pub async fn mode_changed(document: &Document, state: &Rc<RefCell<State>>) -> Result<(), JsValue> {
    let settings_only = mode(document);
    let has_files = !state.borrow().import.files.is_empty();
    state.borrow_mut().import.settings_only = settings_only;
    if has_files {
        classify_all(document, state).await?;
    }
    Ok(())
}

async fn classify_all(document: &Document, state: &Rc<RefCell<State>>) -> Result<(), JsValue> {
    let (files, settings_only) = {
        let current = state.borrow();
        (current.import.files.clone(), current.import.settings_only)
    };
    render::loading(
        document,
        if settings_only {
            "AI でファイルを分類中…（設定のみ）"
        } else {
            "AI でファイルを分類中…"
        },
    )?;
    let mut candidates = Vec::with_capacity(files.len());
    for file in &files {
        candidates.push(classify::classify(file, settings_only).await);
    }
    render::preview(document, &files, &candidates, settings_only)?;
    state.borrow_mut().import.candidates = candidates;
    Ok(())
}

pub async fn confirm(
    document: &Document,
    state: &Rc<RefCell<State>>,
    project_id: &str,
) -> Result<bool, JsValue> {
    let (files, mut candidates, settings_only) = {
        let current = state.borrow();
        (
            current.import.files.clone(),
            current.import.candidates.clone(),
            current.import.settings_only,
        )
    };
    if files.is_empty() || candidates.is_empty() {
        choose_folder(document)?;
        return Ok(false);
    }
    for (index, candidate) in candidates.iter_mut().enumerate() {
        if let Some(select) = document
            .query_selector(&format!(r#"[data-import-type="{index}"]"#))?
            .and_then(|item| item.dyn_into::<HtmlSelectElement>().ok())
        {
            candidate.file_type = select.value();
        }
    }
    render::loading(document, "取り込み中…")?;
    let inputs = files
        .iter()
        .zip(candidates)
        .filter(|(_, candidate)| {
            candidate.file_type != "ignore"
                && (!settings_only
                    || matches!(
                        candidate.file_type.as_str(),
                        "character" | "world" | "relationship"
                    ))
        })
        .map(|(file, candidate)| ImportFile {
            path: file.path.clone(),
            filename: file.filename.clone(),
            file_type: candidate.file_type,
            title: candidate.title,
            content: file.content.clone(),
            fields: candidate.fields,
            episode_title: candidate.episode_title,
            relationships: candidate.relationships,
        })
        .collect::<Vec<_>>();
    let result: ImportResult = invoke::invoke(
        "import_files",
        &ImportArgs {
            project_id,
            files: &inputs,
        },
    )
    .await?;
    render::result(document, &result)?;
    if checked(document, "chk-import-double-check") {
        render::loading(document, "取り込み結果の整合性を確認中…")?;
        let review = review::review_and_fix(project_id, &result).await?;
        render::result_with_review(document, &result, &review)?;
    }
    state.borrow_mut().import = ImportState::default();
    Ok(true)
}

pub fn cancel(document: &Document, state: &Rc<RefCell<State>>) -> Result<(), JsValue> {
    state.borrow_mut().import = ImportState::default();
    render::hide(document)
}

fn mode(document: &Document) -> bool {
    document
        .get_element_by_id("radio-import-settings-only")
        .and_then(|item| item.dyn_into::<HtmlInputElement>().ok())
        .map(|input| input.checked())
        .unwrap_or(false)
}

fn checked(document: &Document, id: &str) -> bool {
    document
        .get_element_by_id(id)
        .and_then(|item| item.dyn_into::<HtmlInputElement>().ok())
        .map(|input| input.checked())
        .unwrap_or(false)
}

fn is_text_file(name: &str) -> bool {
    let name = name.to_lowercase();
    name.ends_with(".md") || name.ends_with(".txt") || name.ends_with(".csv")
}
