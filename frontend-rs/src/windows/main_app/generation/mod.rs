pub(crate) mod craft;
pub(crate) mod old_prompts;
mod prompts;
pub(crate) mod review;

use std::cell::RefCell;
use std::rc::Rc;

use serde_json::Value;
use wasm_bindgen::JsValue;

use crate::ai::draft_checks;
use crate::ai::plan_beats;
use crate::ai::style_fingerprint;
use crate::runtime::ai;

/// ドラフト生成中のテキストデルタを受け取るコールバック
pub type ChunkCallback = Rc<RefCell<dyn FnMut(&str)>>;

#[derive(Clone, Default)]
pub struct FictionReferences {
    pub settings_context: String,
    pub related_scenes: Option<String>,
    pub character_names: Vec<String>,
    pub character_excerpts: String,
}

pub async fn continue_story_with_references_progress<F>(
    settings: &Value,
    context: &str,
    instruction: &str,
    references: &FictionReferences,
    mut on_stage: F,
) -> Result<ai::GeneratedText, JsValue>
where
    F: FnMut(&str),
{
    continue_story_full(
        settings,
        context,
        instruction,
        references,
        &mut on_stage,
        None,
        None,
    )
    .await
}

/// on_chunk 付きの完全版。ドラフト生成中にテキストデルタをリアルタイムで受け取れる。
pub async fn continue_story_streaming<F>(
    settings: &Value,
    context: &str,
    instruction: &str,
    references: &FictionReferences,
    mut on_stage: F,
    on_chunk: ChunkCallback,
    previous_episode_text: Option<&str>,
) -> Result<ai::GeneratedText, JsValue>
where
    F: FnMut(&str),
{
    continue_story_full(
        settings,
        context,
        instruction,
        references,
        &mut on_stage,
        Some(on_chunk),
        previous_episode_text,
    )
    .await
}

async fn continue_story_full<F>(
    settings: &Value,
    context: &str,
    instruction: &str,
    references: &FictionReferences,
    on_stage: &mut F,
    on_chunk: Option<ChunkCallback>,
    previous_episode_text: Option<&str>,
) -> Result<ai::GeneratedText, JsValue>
where
    F: FnMut(&str),
{
    // 文体指紋を計測し、旧 TypeScript と同じ文体指標セクションをドラフトへ渡す。
    // 現エピソードが短い場合、直前エピソードの本文を補って計測材料を確保する（TS版 findPreviousEpisodeContent 相当）。
    let style_sample = style_fingerprint::compose_style_sample_text(context, previous_episode_text);
    let fingerprint = style_fingerprint::measure_style_fingerprint(&style_sample);
    let endings = fingerprint
        .sentence_endings
        .iter()
        .take(5)
        .map(|entry| format!("「{}」{:.0}%", entry.form, entry.ratio * 100.0))
        .collect::<Vec<_>>()
        .join(" / ");
    let fingerprint_section = old_prompts::style_fingerprint_section(
        fingerprint.average_sentence_length,
        fingerprint.kanji_ratio,
        fingerprint.dialogue_ratio,
        fingerprint.average_sentences_per_paragraph,
        &endings,
    );

    let scene = if enabled(settings, "continuationSceneStateEnabled") {
        on_stage("場面状態を整理中");
        optional_judgment(
            "あなたは小説の連続性を管理する編集者です。",
            prompts::scene_state(context, nonempty(&references.settings_context)),
            &mut *on_stage,
        )
        .await
    } else {
        String::new()
    };
    let voices = if enabled(settings, "continuationCharacterVoiceEnabled")
        && !references.character_names.is_empty()
    {
        on_stage("人物の話し方を整理中");
        optional_judgment(
            "あなたは登場人物の声と呼称を管理する編集者です。",
            prompts::character_voices(
                &references.character_names,
                if references.character_excerpts.trim().is_empty() {
                    context
                } else {
                    &references.character_excerpts
                },
                nonempty(&references.settings_context),
            ),
            &mut *on_stage,
        )
        .await
    } else {
        String::new()
    };
    let plan = if enabled(settings, "twoStageContinuation") {
        on_stage("構想を作成中");
        ai::generate(
            "judgment",
            craft::system_with_principles(judgment_scaffold(settings)),
            prompts::plan(
                context,
                instruction,
                enabled(settings, "continuationBeatSplitEnabled"),
                &scene,
                &voices,
                nonempty(&references.settings_context),
                references.related_scenes.as_deref(),
            ),
        )
        .await?
        .text
    } else {
        String::new()
    };

    // 構成点検: 構想を現在の局面と前話のあらすじに照合し、報告を構想に追記する。
    // 失敗しても続行できる(craftStructureCheckEnabled のみで制御)。
    let plan = if enabled(settings, "craftStructureCheckEnabled") && !plan.trim().is_empty() {
        on_stage("構成を点検中");
        let check = optional_judgment(
            &craft::system_with_principles(judgment_scaffold(settings)),
            craft::structure_check(
                context,
                nonempty(&references.settings_context),
                Some(&plan),
            ),
            &mut *on_stage,
        )
        .await;
        if check.trim().is_empty() {
            plan
        } else {
            format!("{plan}\n\n【構成点検の報告】\n{check}")
        }
    } else {
        plan
    };

    // 文学目標カード: 構想を「読者への効果」の観点から設計カード化する。
    // ドラフト・査読・改稿へ基準として渡る(continuationCraftCardEnabled のみで制御)。
    let craft_card = if enabled(settings, "continuationCraftCardEnabled") {
        on_stage("文学目標カードを作成中");
        optional_judgment(
            &craft::system_with_principles(judgment_scaffold(settings)),
            craft::craft_card(
                context,
                Some(&plan),
                nonempty(&references.settings_context),
                judgment_scaffold(settings),
            ),
            &mut *on_stage,
        )
        .await
    } else {
        String::new()
    };

    // ビート分割生成: 構想メモから主要ビートを抽出
    let beats = if enabled(settings, "continuationBeatSplitEnabled") && !plan.is_empty() {
        plan_beats::parse_plan_beats(&plan)
    } else {
        vec![]
    };
    let best_of_two = enabled(settings, "continuationBestOfTwo");
    // ベスト2候補生成とビート分割は粒度が異なり併用しない（ベスト2優先）。
    // 両方有効かつビート分割の材料が揃っている場合のみ、休止していることを
    // 一度だけ可視化する（設定上は両方ONのまま気づかず使い続ける事故を防ぐ）。
    if beats.len() >= 2 && best_of_two {
        on_stage("ベスト2優先のためビート分割は休止中");
    }
    on_stage(if beats.len() >= 2 && !best_of_two {
        "ビートごとに本文を生成中"
    } else {
        "本文候補を生成中"
    });
    let first = if beats.len() >= 2 && !best_of_two {
        draft_beats(
            context,
            instruction,
            &plan,
            &scene,
            &voices,
            &fingerprint_section,
            references,
            scaffold(settings),
            &craft_card,
            &beats,
        )
        .await?
    } else {
        draft(
            context,
            instruction,
            &plan,
            &scene,
            &voices,
            &fingerprint_section,
            references,
            scaffold(settings),
            &craft_card,
            None,
            on_chunk.clone(),
        )
        .await?
    };
    let mut selected = if best_of_two {
        on_stage("第2候補を生成中");
        let second = draft(
            context,
            instruction,
            &plan,
            &scene,
            &voices,
            &fingerprint_section,
            references,
            scaffold(settings),
            &craft_card,
            None,
            None,
        )
        .await?;
        on_stage("候補を比較中");
        if review::choose_draft(
            &first.text,
            &second.text,
            context,
            nonempty(&references.settings_context),
            nonempty(&plan),
            judgment_scaffold(settings),
            Some(instruction),
        )
        .await?
        {
            second
        } else {
            first
        }
    } else {
        first
    };

    // 機械検査: ハード違反があれば破棄して再生成（最大1回リトライ）
    let mechanical = draft_checks::check_draft(&selected.text, context);
    if !mechanical.hard.is_empty() {
        on_stage("機械検査の指摘を再生成中");
        let retry = draft(
            context,
            instruction,
            &plan,
            &scene,
            &voices,
            &fingerprint_section,
            references,
            scaffold(settings),
            &craft_card,
            None,
            None,
        )
        .await?;
        let retry_check = draft_checks::check_draft(&retry.text, context);
        if retry_check.hard.len() < mechanical.hard.len() {
            selected = retry;
        }
    }

    if enabled(settings, "continuationReviewEnabled") {
        let j_scaffold = judgment_scaffold(settings);
        let extras = old_prompts::fiction_extra_sections(&scene, &voices, &fingerprint_section);
        on_stage(if craft_card.trim().is_empty() {
            "判断モデルで査読中"
        } else {
            "文学目標と照合しながら査読中"
        });
        let mut findings = if craft_card.trim().is_empty() {
            review::inspect(
                context,
                &selected.text,
                nonempty(&references.settings_context),
                nonempty(&plan),
                references.related_scenes.as_deref(),
                &extras,
                j_scaffold,
            )
            .await?
        } else {
            review::inspect_craft(
                context,
                &selected.text,
                &craft_card,
                nonempty(&references.settings_context),
                nonempty(&plan),
                references.related_scenes.as_deref(),
                &extras,
                j_scaffold,
            )
            .await?
        };
        // craft 検証(初読読者・緩急・テーマ)を査読に重ねる。各トグルは独立。
        let mut craft_findings = Vec::new();
        if enabled(settings, "craftReaderSimEnabled") {
            on_stage("初読読者の視点で検証中");
            craft_findings.push(
                run_craft_audit(
                    "初読読者",
                    craft::reader_sim(context, &selected.text),
                    craft::reader_sim_schema(),
                    "events",
                    &mut *on_stage,
                )
                .await,
            );
        }
        if enabled(settings, "craftPacingAuditEnabled") {
            on_stage("緩急と情報開示を監査中");
            craft_findings.push(
                run_craft_audit(
                    "緩急",
                    craft::pacing_audit(context, &selected.text),
                    craft::pacing_audit_schema(),
                    "findings",
                    &mut *on_stage,
                )
                .await,
            );
        }
        if enabled(settings, "craftThemeAuditEnabled") {
            on_stage("テーマと約束を監査中");
            craft_findings.push(
                run_craft_audit(
                    "テーマ",
                    craft::theme_audit(
                        context,
                        nonempty(&references.settings_context),
                        nonempty(&references.settings_context),
                        &selected.text,
                    ),
                    craft::theme_audit_schema(),
                    "findings",
                    &mut *on_stage,
                )
                .await,
            );
        }
        let craft_findings = craft_findings
            .into_iter()
            .filter(|value| !value.trim().is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        if !craft_findings.trim().is_empty() {
            findings.push_str("\n\n【craft検証による指摘】\n");
            findings.push_str(&craft_findings);
        }
        let checked = draft_checks::check_draft(&selected.text, context);
        // hard違反は決定論的に「誤りである」と言い切れる検査のみ（文の反復等）。
        // soft（一人称ドリフト等）は意図的な視点交代の可能性があるため、
        // 参考情報として findings には含めるが、改稿ゲートは動かさない。
        let has_hard_mechanical = !checked.hard.is_empty();
        let mechanical_findings = checked
            .hard
            .into_iter()
            .chain(checked.soft)
            .collect::<Vec<_>>();
        if !mechanical_findings.is_empty() {
            findings.push_str("\n\n【機械検査による指摘】\n");
            findings.push_str(
                &mechanical_findings
                    .into_iter()
                    .map(|item| format!("- {item}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
            );
        }
        // LLM査読が「問題なし」と判定していても、機械検査のhard違反が
        // 残っている場合は改稿へ進む（査読が見落とした反復等を黙って通さない）。
        if !review_gate_requires_revision(&findings, has_hard_mechanical) {
            return Ok(selected);
        }
        on_stage("査読結果から改稿中");
        let mut revise_extras = extras.clone();
        if !craft_card.trim().is_empty() {
            revise_extras.push('\n');
            revise_extras.push_str(&craft::craft_card_section(&craft_card));
        }
        let revised = revise_with_review(
            context,
            &selected.text,
            &findings,
            enabled(settings, "continuationTargetedRevision"),
            scaffold(settings),
            nonempty(&references.settings_context),
            references.related_scenes.as_deref(),
            &revise_extras,
        )
        .await?;
        if revised.text == selected.text {
            return Ok(selected);
        }
        on_stage("改稿の回帰を確認中");
        if !revised.text.trim().is_empty()
            && review::prefer_revision(
                context,
                &selected.text,
                &revised.text,
                nonempty(&references.settings_context),
                judgment_scaffold(settings),
                enabled(settings, "craftCompareRevisionsEnabled"),
            )
            .await?
        {
            selected = revised;
        }
    }
    Ok(selected)
}

/// 書き直しの内部段階を受け取る完全版。ツールカードに現在の処理を表示する。
pub async fn rewrite_passage_with_references_progress<F>(
    settings: &Value,
    context: &str,
    passage: &str,
    instruction: &str,
    references: &FictionReferences,
    mut on_stage: F,
) -> Result<ai::GeneratedText, JsValue>
where
    F: FnMut(&str),
{
    rewrite_passage_streaming_with_progress(
        settings,
        context,
        passage,
        instruction,
        references,
        None,
        &mut on_stage,
    )
    .await
}

/// on_chunk 付きの書き直し。第一候補の生成中にテキストデルタを受け取れる。
pub async fn rewrite_passage_streaming(
    settings: &Value,
    context: &str,
    passage: &str,
    instruction: &str,
    references: &FictionReferences,
    on_chunk: Option<ChunkCallback>,
) -> Result<ai::GeneratedText, JsValue> {
    rewrite_passage_streaming_with_progress(
        settings,
        context,
        passage,
        instruction,
        references,
        on_chunk,
        &mut |_| {},
    )
    .await
}

async fn rewrite_passage_streaming_with_progress<F>(
    settings: &Value,
    context: &str,
    passage: &str,
    instruction: &str,
    references: &FictionReferences,
    on_chunk: Option<ChunkCallback>,
    on_stage: &mut F,
) -> Result<ai::GeneratedText, JsValue>
where
    F: FnMut(&str),
{
    on_stage("設定資料を確認中");
    on_stage("書き直し案を生成中");
    let first = rewrite_candidate(
        context,
        passage,
        instruction,
        references,
        scaffold(settings),
        on_chunk,
    )
    .await?;
    let mut selected = if enabled(settings, "continuationBestOfTwo") {
        on_stage("別の書き直し案を生成中");
        let second = rewrite_candidate(
            context,
            passage,
            instruction,
            references,
            scaffold(settings),
            None,
        )
        .await?;
        on_stage("書き直し案を比較中");
        if review::choose_candidate(
            &first.text,
            &second.text,
            instruction,
            passage,
            context,
            nonempty(&references.settings_context),
            judgment_scaffold(settings),
        )
        .await?
        {
            second
        } else {
            first
        }
    } else {
        first
    };
    if enabled(settings, "continuationReviewEnabled") {
        on_stage("書き直し案を査読中");
        let findings = review::inspect(
            context,
            &selected.text,
            nonempty(&references.settings_context),
            None,
            references.related_scenes.as_deref(),
            "",
            scaffold(settings),
        )
        .await?;
        if !review::requires_revision(&findings) {
            return Ok(selected);
        }
        on_stage("査読結果から改稿中");
        let revised = revise_with_review(
            context,
            &selected.text,
            &findings,
            enabled(settings, "continuationTargetedRevision"),
            scaffold(settings),
            nonempty(&references.settings_context),
            references.related_scenes.as_deref(),
            "",
        )
        .await?;
        if revised.text == selected.text {
            return Ok(selected);
        }
        on_stage("改稿候補を比較中");
        if !revised.text.trim().is_empty()
            && review::prefer_revision(
                context,
                &selected.text,
                &revised.text,
                nonempty(&references.settings_context),
                judgment_scaffold(settings),
                enabled(settings, "craftCompareRevisionsEnabled"),
            )
            .await?
        {
            selected = revised;
        }
    }
    on_stage("書き直し結果を整形中");
    Ok(selected)
}

async fn draft(
    context: &str,
    instruction: &str,
    plan: &str,
    scene: &str,
    voices: &str,
    style_fingerprint: &str,
    references: &FictionReferences,
    scaffold: Option<&str>,
    craft: &str,
    beat_directive: Option<(&str, usize, usize)>,
    on_chunk: Option<ChunkCallback>,
) -> Result<ai::GeneratedText, JsValue> {
    let prompt = prompts::draft(
        context,
        instruction,
        plan,
        scene,
        voices,
        nonempty(&references.settings_context),
        references.related_scenes.as_deref(),
        scaffold,
        Some(style_fingerprint),
        beat_directive,
        (!craft.trim().is_empty()).then_some(craft),
    );
    let system: String = craft::system_with_principles(scaffold);
    let mut result = if let Some(callback) = on_chunk {
        let cb = Rc::clone(&callback);
        ai::generate_streaming(
            "writing",
            system,
            prompt.clone(),
            None,
            None,
            move |chunk| {
                (cb.borrow_mut())(chunk);
            },
        )
        .await?
    } else {
        ai::generate("writing", system, prompt.clone()).await?
    };
    // TS の continuation と同じく、出力上限で切れた場合は同じ会話を
    // 最大2回だけ継続し、途中で欠けた本文をそのまま連結する。
    for _ in 0..2 {
        if !is_length_finish(result.finish_reason.as_deref()) {
            break;
        }
        let turn = ai::agent_turn(
            "writing",
            craft::system_with_principles(scaffold),
            vec![
                serde_json::json!({"role":"user","content":prompt}),
                serde_json::json!({"role":"assistant","content":result.text}),
                serde_json::json!({"role":"user","content":"直前の出力は長さ上限で途切れた。同じ本文を繰り返さず、中断した位置から小説本文だけを続けてください。"}),
            ],
            Vec::new(),
            None,
            None,
        ).await?;
        result.text.push_str(&turn.text);
        result.finish_reason = turn.finish_reason;
    }
    // 機械的サニタイズ: 前置き・コードフェンス・見出しの除去
    result.text = draft_checks::sanitize_draft_text(&result.text);
    Ok(result)
}

/// 改稿ゲート: LLM査読が要修正と判定したか、機械検査のhard違反が残っているかのどちらかで改稿へ進む。
fn review_gate_requires_revision(findings: &str, has_hard_mechanical: bool) -> bool {
    review::requires_revision(findings) || has_hard_mechanical
}

/// finish_reason が「出力上限で切れた」ことを示すかを判定する。
/// プロバイダごとの生値をそのまま受け取る前提で、大小文字を無視して
/// OpenAI chat("length")、Anthropic/OpenAI compatible("max_tokens")、
/// OpenAI responses("max_output_tokens")、Gemini("MAX_TOKENS")を等しく扱う。
pub(crate) fn is_length_finish(reason: Option<&str>) -> bool {
    reason.is_some_and(|reason| {
        matches!(
            reason.to_ascii_lowercase().as_str(),
            "length" | "max_tokens" | "max_output_tokens"
        )
    })
}

async fn draft_beats(
    context: &str,
    instruction: &str,
    plan: &str,
    scene: &str,
    voices: &str,
    style_fingerprint: &str,
    references: &FictionReferences,
    scaffold: Option<&str>,
    craft: &str,
    beats: &[String],
) -> Result<ai::GeneratedText, JsValue> {
    let mut cumulative_context = context.to_string();
    let mut combined: Option<ai::GeneratedText> = None;
    for (index, beat) in beats.iter().enumerate() {
        let part = draft(
            &cumulative_context,
            instruction,
            plan,
            scene,
            voices,
            style_fingerprint,
            references,
            scaffold,
            craft,
            Some((beat, index + 1, beats.len())),
            None,
        )
        .await?;
        let part_text = part.text.clone();
        if let Some(result) = combined.as_mut() {
            result.text.push_str(&part_text);
        } else {
            combined = Some(part);
        }
        cumulative_context.push_str(&part_text);
        cumulative_context = cumulative_context
            .chars()
            .rev()
            .take(24_000)
            .collect::<String>()
            .chars()
            .rev()
            .collect();
    }
    combined.ok_or_else(|| JsValue::from_str("構想メモからビートを取得できませんでした。"))
}

async fn rewrite_candidate(
    context: &str,
    passage: &str,
    instruction: &str,
    references: &FictionReferences,
    scaffold: Option<&str>,
    on_chunk: Option<ChunkCallback>,
) -> Result<ai::GeneratedText, JsValue> {
    let system: String = craft::system_with_principles(scaffold);
    let prompt = prompts::rewrite(
        context,
        passage,
        scaffold,
        Some(instruction),
        nonempty(&references.settings_context),
    );
    if let Some(callback) = on_chunk {
        let cb = Rc::clone(&callback);
        ai::generate_streaming("writing", system, prompt, None, None, move |chunk| {
            (cb.borrow_mut())(chunk);
        })
        .await
    } else {
        ai::generate("writing", system, prompt).await
    }
}

/// 場面状態カード・話し方カードのような「無くても続行できる」判断系生成。
/// 失敗しても続きの生成は止めない（カード無しで続行）が、黙って握り潰さず
/// on_stage で一拍可視化する（詳細は runtime::ai のログに残る）。
async fn optional_judgment(
    system: &str,
    prompt: String,
    on_stage: &mut dyn FnMut(&str),
) -> String {
    match ai::generate("judgment", system.to_owned(), prompt).await {
        Ok(result) => result.text,
        Err(_) => {
            on_stage("場面整理に失敗（スキップして続行）");
            String::new()
        }
    }
}

/// craft 検証(初読読者・緩急・テーマ)の実行。構造化出力が返すリストを
/// 査読に追記できる1行ずつの指摘文に整形する。失敗したらスキップする
/// (optional_judgment と同じ failure-tolerant 方針)。
async fn run_craft_audit(
    label: &str,
    prompt: String,
    schema: Value,
    list_key: &str,
    on_stage: &mut dyn FnMut(&str),
) -> String {
    let result = crate::ai::structured_output::generate_structured_object::<Value>(
        "judgment",
        Some(&craft::full_system()),
        &prompt,
        schema,
        None,
        None,
    )
    .await;
    let value = match result {
        Ok(value) => value,
        Err(_) => {
            on_stage(&format!("{label}検証に失敗（スキップして続行）"));
            return String::new();
        }
    };
    let mut lines = value
        .get(list_key)
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(format_craft_finding)
        .collect::<Vec<_>>();
    if let Some(summary) = value.get("summary").and_then(Value::as_str) {
        if !summary.trim().is_empty() {
            lines.push(format!("- 総評: {}", summary.trim()));
        }
    }
    lines.join("\n")
}

/// 監査結果の1要素を「- L{行} [{種別}] {理由}」の1行にする。
/// 行番号・種別・理由のいずれかが欠けている要素は捨てる。
fn format_craft_finding(item: &Value) -> Option<String> {
    let reason = item.get("reason").and_then(Value::as_str)?.trim();
    if reason.is_empty() {
        return None;
    }
    let line = item
        .get("line")
        .and_then(Value::as_i64)
        .map(|value| value.to_string())
        .unwrap_or_else(|| "?".into());
    let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
    Some(format!("- L{line} [{kind}] {reason}"))
}

fn enabled(settings: &Value, key: &str) -> bool {
    settings.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn nonempty(value: &str) -> Option<&str> {
    (!value.trim().is_empty()).then_some(value)
}

/// 執筆系プロンプトの scaffold("light" 等)を設定から解決する。
/// 優先順位: 設定画面の執筆詳細(writingOverrides.promptScaffold)
/// → 旧形式のトップレベル promptScaffold
/// → seed_model_scaffold_defaults が注入したモデルカタログ既定値
/// → None(重装)。
pub(crate) fn scaffold(settings: &Value) -> Option<&str> {
    settings
        .get("writingOverrides")
        .and_then(|overrides| overrides.get("promptScaffold"))
        .and_then(Value::as_str)
        .or_else(|| settings.get("promptScaffold").and_then(Value::as_str))
        .or_else(|| {
            settings
                .get("writingModelDefaultScaffold")
                .and_then(Value::as_str)
        })
        .filter(|value| !value.trim().is_empty())
}

/// 判断系タスク(候補比較・査読基準)のプロンプトに使う scaffold。
/// judgmentOverrides.promptScaffold を優先し、トップレベル、
/// 最後に判断系モデルのカタログ既定値へフォールバックする。
pub(crate) fn judgment_scaffold(settings: &Value) -> Option<&str> {
    settings
        .get("judgmentOverrides")
        .and_then(|overrides| overrides.get("promptScaffold"))
        .and_then(Value::as_str)
        .or_else(|| settings.get("promptScaffold").and_then(Value::as_str))
        .or_else(|| {
            settings
                .get("judgmentModelDefaultScaffold")
                .and_then(Value::as_str)
        })
        .filter(|value| !value.trim().is_empty())
}

/// 生成パイプラインの入口で1度だけ呼ぶ。writingOverrides/judgmentOverrides や
/// トップレベル promptScaffold にユーザーの明示指定が既にある場合は
/// ai_runtime_config への問い合わせをスキップする。無い場合のみ、実際に
/// 解決されるモデル（providers.json の writing/judgment プロファイル）の
/// promptScaffold 既定値を取得し、settings のクローンへ注入する。
/// この注入先キーは scaffold()/judgment_scaffold() の最終フォールバックとしてのみ
/// 参照され、writingOverrides 等のユーザー設定とは混同されない。
pub(crate) async fn seed_model_scaffold_defaults(settings: Value) -> Value {
    let settings = seed_writing_scaffold_default(settings).await;
    seed_judgment_scaffold_default(settings).await
}

/// writing ロールのモデル既定 scaffold だけを注入する版。
/// writing ロールのコンテキスト上限も同時に取得したい呼び出し元
/// （本文スライス長の算出と1回のai_runtime_config呼び出しで済ませたい場合）は、
/// これを呼ばず ai::role_defaults("writing") を直接使う。
pub(crate) async fn seed_writing_scaffold_default(mut settings: Value) -> Value {
    if scaffold(&settings).is_none() {
        if let Ok(defaults) = ai::role_defaults("writing").await {
            if let Some(value) = defaults.prompt_scaffold {
                if let Some(obj) = settings.as_object_mut() {
                    obj.insert("writingModelDefaultScaffold".into(), Value::String(value));
                }
            }
        }
    }
    settings
}

/// judgment ロールのモデル既定 scaffold だけを注入する版。
pub(crate) async fn seed_judgment_scaffold_default(mut settings: Value) -> Value {
    if judgment_scaffold(&settings).is_none() {
        if let Ok(defaults) = ai::role_defaults("judgment").await {
            if let Some(value) = defaults.prompt_scaffold {
                if let Some(obj) = settings.as_object_mut() {
                    obj.insert("judgmentModelDefaultScaffold".into(), Value::String(value));
                }
            }
        }
    }
    settings
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn scaffold_falls_back_to_seeded_model_default_when_no_explicit_override() {
        // writingOverrides/トップレベル promptScaffold のどちらも無い場合のみ、
        // seed_model_scaffold_defaults が注入する既定値が採用される。
        assert_eq!(
            scaffold(&json!({"writingModelDefaultScaffold":"light"})),
            Some("light")
        );
        // 明示オーバーライドがあれば既定値より優先される。
        assert_eq!(
            scaffold(&json!({
                "promptScaffold":"heavy",
                "writingModelDefaultScaffold":"light"
            })),
            Some("heavy")
        );
        assert_eq!(
            judgment_scaffold(&json!({"judgmentModelDefaultScaffold":"light"})),
            Some("light")
        );
    }

    #[test]
    fn review_gate_forces_revision_on_hard_mechanical_violation_even_if_review_is_clean() {
        assert!(review_gate_requires_revision("【総合判定】問題なし", true));
        assert!(!review_gate_requires_revision("【総合判定】問題なし", false));
        assert!(review_gate_requires_revision("【総合判定】要修正", false));
    }

    #[test]
    fn missing_pipeline_flags_are_disabled() {
        assert!(!enabled(&json!({}), "continuationReviewEnabled"));
        assert!(enabled(
            &json!({"continuationReviewEnabled":true}),
            "continuationReviewEnabled"
        ));
    }

    #[test]
    fn every_prompt_keeps_original_context() {
        let context = "固有の本文末尾";
        assert!(
            prompts::draft(context, "", "", "", "", None, None, None, None, None, None)
                .contains(context)
        );
        assert!(prompts::review(context, "候補", None, None, None, "").contains(context));
        assert!(
            prompts::candidate_selection("前", "後", "改稿", "前", context, None, None)
                .contains(context)
        );
        assert!(prompts::rewrite(context, "対象", None, None, None).contains(context));
    }

    #[test]
    fn draft_includes_generated_continuity_cards_and_style() {
        let card = craft::craft_card_section("【この場面の目的】対立を深める");
        let prompt = prompts::draft(
            "直前本文",
            "続ける",
            "構想",
            "場所: 書斎",
            "主人公: 私、常体",
            None,
            None,
            None,
            Some("【文体指標】短文中心"),
            Some(("扉を開ける", 1, 2)),
            Some(&card),
        );
        assert!(prompt.contains("【場面の現在状態"));
        assert!(prompt.contains("<reference_data name=\"scene_state\">\n場所: 書斎"));
        assert!(prompt.contains("【人物の話し方カード"));
        assert!(prompt.contains("<reference_data name=\"character_voice_cards\">"));
        assert!(prompt.contains("【文体指標】短文中心"));
        assert!(prompt.contains("ビート1/2「扉を開ける」"));
        assert!(prompt.contains("【LITRA工程】continuation-draft/v2"));
        assert!(prompt.contains("【最終指示"));
        assert!(prompt.contains("【執筆前の確定"));
        assert!(prompt.contains("【文学目標カード"));
        assert!(prompt.contains("<reference_data name=\"craft_card\">"));
        assert!(prompt.contains("【この場面の目的】対立を深める"));
    }

    #[test]
    fn plan_includes_continuity_cards_when_available() {
        let prompt = prompts::plan(
            "本文",
            "続ける",
            false,
            "場所: 書斎",
            "主人公: 私、常体",
            None,
            None,
        );
        assert!(prompt.contains("<reference_data name=\"scene_state\">\n場所: 書斎"));
        assert!(prompt.contains("<reference_data name=\"character_voice_cards\">"));
    }

    #[test]
    fn scaffold_resolves_overrides_and_switches_tiers() {
        assert_eq!(
            scaffold(&json!({"writingOverrides":{"promptScaffold":"light"}})),
            Some("light")
        );
        assert_eq!(scaffold(&json!({"promptScaffold":"light"})), Some("light"));
        assert_eq!(scaffold(&json!({})), None);
        assert_eq!(
            judgment_scaffold(&json!({"judgmentOverrides":{"promptScaffold":"light"}})),
            Some("light")
        );
        let heavy = prompts::draft("本文", "", "", "", "", None, None, None, None, None, None);
        assert!(heavy.contains("【執筆前の確定"));
        assert!(!heavy.contains("【メタ認知"));
        let light = prompts::draft(
            "本文",
            "",
            "",
            "",
            "",
            None,
            None,
            Some("light"),
            None,
            None,
            None,
        );
        assert!(light.contains("【メタ認知 — 執筆中の自己監視】"));
        assert!(light.contains("【日本語小説としての生成方針 — 要点】"));
        let heavy_revise = prompts::revise("本文", "草稿", "査読", false, None, None, None, "");
        assert!(heavy_revise.contains("修正稿の全文だけである"));
    }

    #[test]
    fn plan_never_contains_draft_output_instructions() {
        let prompt = prompts::plan("本文", "続ける", false, "", "", None, None);
        assert!(prompt.contains("continuation-plan/v2"));
        assert!(!prompt.contains("continuation-draft/v2"));
        assert!(!prompt.contains("出力の1文字目から小説本文を書く"));
    }

    #[test]
    fn feedback_and_line_edit_use_full_ts_templates() {
        let feedback = old_prompts::feedback("対象", "設定");
        assert!(feedback.contains("【評価項目 — すべて確認する】"));
        assert!(feedback.contains("【優先して直す点】"));
        let review = old_prompts::line_edit_review("対象", "周囲", None, None, Some("設定"), None);
        assert!(review.contains("4観点で1文ずつ点検"));
        assert!(!review.contains("{instructionSection}"));
        assert!(!review.contains("formatPromptDataBlock"));
        let tool_need =
            old_prompts::tool_call_need("保存して", Some("保存します"), &["saveMemo".to_string()]);
        assert!(tool_need.contains("- saveMemo"));
        assert!(tool_need.contains("needsTools=true"));
        assert!(!tool_need.contains("availableToolNames.length"));
    }

    #[test]
    fn targeted_replacements_only_change_unique_non_overlapping_ranges() {
        let replacements = vec![
            old_prompts::TargetedReplacement {
                target: "古い文。".into(),
                replacement: "新しい文。".into(),
            },
            old_prompts::TargetedReplacement {
                target: "重複。".into(),
                replacement: "変更しない。".into(),
            },
        ];
        assert_eq!(
            apply_targeted_replacements("前。古い文。重複。重複。後。", &replacements),
            Some("前。新しい文。重複。重複。後。".into())
        );
    }

    #[test]
    fn craft_finding_lines_keep_line_kind_and_reason() {
        use serde_json::json;
        assert_eq!(
            format_craft_finding(&json!({"line": 12, "type": "confused", "reason": "誰の発言か分からない"})),
            Some("- L12 [confused] 誰の発言か分からない".into())
        );
        // 行番号が無くても種別と理由があれば整形する
        assert_eq!(
            format_craft_finding(&json!({"type": "stalled", "reason": "緊張が更新されない"})),
            Some("- L? [stalled] 緊張が更新されない".into())
        );
        // 理由が無い要素は捨てる
        assert_eq!(
            format_craft_finding(&json!({"line": 3, "type": "hooked"})),
            None
        );
    }

    #[test]
    fn craft_card_reaches_draft_through_prompt() {
        // continue_story_full の配線で card は draft の craft_section に渡る。
        // ここでは old_prompts::draft 単体での注入を確認する。
        let section = craft::craft_card_section("【この場面の目的】対立を深める");
        let prompt = prompts::draft(
            "本文",
            "",
            "",
            "",
            "",
            None,
            None,
            None,
            None,
            None,
            Some(&section),
        );
        assert!(prompt.contains("【文学目標カード"));
        assert!(prompt.contains("【この場面の目的】対立を深める"));
    }
}

async fn revise_with_review(
    context: &str,
    draft: &str,
    review: &str,
    targeted: bool,
    scaffold: Option<&str>,
    settings_context: Option<&str>,
    related_scenes: Option<&str>,
    extra_sections: &str,
) -> Result<ai::GeneratedText, JsValue> {
    if targeted {
        let mut proposal = ai::generate(
            "writing",
            craft::system_with_principles(scaffold),
            prompts::revise(
                context,
                draft,
                review,
                true,
                scaffold,
                settings_context,
                related_scenes,
                extra_sections,
            ),
        )
        .await?;
        if let Some(replacements) = old_prompts::parse_targeted_revision(&proposal.text) {
            if replacements.is_empty() {
                proposal.text = draft.to_string();
                return Ok(proposal);
            }
            if let Some(applied) = apply_targeted_replacements(draft, &replacements) {
                proposal.text = applied;
                return Ok(proposal);
            }
        }
    }
    ai::generate(
        "writing",
        craft::system_with_principles(scaffold),
        prompts::revise(
            context,
            draft,
            review,
            false,
            scaffold,
            settings_context,
            related_scenes,
            extra_sections,
        ),
    )
    .await
}

fn apply_targeted_replacements(
    draft: &str,
    replacements: &[old_prompts::TargetedReplacement],
) -> Option<String> {
    let mut applied = Vec::<(usize, usize, &str)>::new();
    for replacement in replacements {
        let matches = draft
            .match_indices(&replacement.target)
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            continue;
        }
        let start = matches[0];
        let end = start + replacement.target.len();
        if applied
            .iter()
            .any(|(other_start, other_end, _)| start < *other_end && end > *other_start)
        {
            continue;
        }
        applied.push((start, end, replacement.replacement.as_str()));
    }
    if applied.is_empty() {
        return None;
    }
    applied.sort_by_key(|(start, _, _)| *start);
    let mut result = String::new();
    let mut cursor = 0;
    for (start, end, replacement) in applied {
        result.push_str(&draft[cursor..start]);
        result.push_str(replacement);
        cursor = end;
    }
    result.push_str(&draft[cursor..]);
    Some(result)
}
