//! hashline のエラー・警告メッセージ定数。oh-my-pi `messages.ts` の移植（使用するもののみ）。

// ── エンベロープマーカー ────────────────────────────────────────────
pub const BEGIN_PATCH_MARKER: &str = "*** Begin Patch";
pub const END_PATCH_MARKER: &str = "*** End Patch";
pub const ABORT_MARKER: &str = "*** Abort";

// ── パーサ警告・エラー ──────────────────────────────────────────────
pub const BARE_BODY_AUTO_PIPED_WARNING: &str =
    "Auto-prefixed bare body row(s) with `+`. Body rows must be `+TEXT` literal lines.";
pub const MINUS_ROW_REJECTED: &str =
    "`-` rows are not valid; the range already names the lines being changed. For Markdown bullets or other literal `-` lines, prefix the literal row with `+`: `+- item`.";
pub const DELETE_TAKES_NO_BODY: &str =
    "`DEL N.=M` does not take body rows. Remove the body, or use `SWAP N.=M:`.";
pub const EMPTY_INSERT: &str = "`INS` needs at least one `+TEXT` body row.";

// ── ドリフト警告 ────────────────────────────────────────────────────
pub const HEADTAIL_DRIFT_WARNING: &str =
    "Applied the `INS.HEAD:`/`INS.TAIL:` edit despite a stale snapshot tag (file changed since your read) — head/tail position is content-independent. Re-read if the drift was unexpected.";
pub const RECOVERY_EXTERNAL_WARNING: &str =
    "Recovered from a stale file hash using a previous read snapshot (file changed externally between read and edit).";
pub const RECOVERY_SESSION_CHAIN_WARNING: &str =
    "Recovered from a stale file hash using an earlier in-session snapshot (a prior edit in this session advanced the hash).";
pub const RECOVERY_LINE_REMAP_WARNING: &str =
    "Recovered by remapping stale line anchors to unchanged current lines (file changed since the tagged read). Verify the diff matches your intent.";

/// seen-line ガードの表示上限。
pub const SEEN_LINE_REVEAL_CAP: usize = 40;
pub const SEEN_LINE_REVEAL_MAX_COLUMNS: usize = 512;
/// mismatch のアンカー上下文の表示行数（前後）。
pub const MISMATCH_CONTEXT: u32 = 2;

/// 行番号の例を生成する（`describe_anchor_examples` 相当）。
pub fn describe_anchor_examples(line_prefix: &str) -> String {
    crate::hashline::format::describe_anchor_examples(line_prefix)
}

/// `DEL N.=M` にコロン/本文がある場合のエラー。
pub fn del_with_colon_message() -> &'static str {
    "`DEL N.=M` has no colon and no body. Remove the colon and body rows."
}

/// 裸の行番号（動詞なし）のエラー。
pub fn bare_number_message() -> &'static str {
    "hunk headers need a verb. Use `SWAP N.=N:` to replace, or `DEL N` to delete."
}

/// 裸の範囲（動詞なし）のエラー。
pub fn bare_range_message() -> &'static str {
    "bare range hunk header is not valid. Hunk headers need a verb: write `SWAP A.=B:` or `DEL A.=B`."
}

/// スナップショットタグ欠落のエラー。
pub fn missing_snapshot_tag_message(path: &str) -> String {
    format!(
        "Missing hashline snapshot tag for {path}; use `[{path}#tag]` from your latest read/search output. To create a new file, use the write tool."
    )
}

/// 曖昧な境界echo（ペイロードが短すぎる）のエラー。
pub fn ambiguous_boundary_echo_message(start: u32, end: u32, side: &str, count: usize) -> String {
    let side_text = if side == "leading" {
        format!("opens by restating the {count} line(s) just above the range")
    } else {
        format!("ends by restating the {count} line(s) just below the range")
    };
    format!(
        "`SWAP {start}.={end}:` rejected: the body {side_text}, but is too short to be the full final content of the widened range — applying it as-is or auto-repairing would delete range line(s) the body never restates. Re-issue with the range covering exactly the lines that change and the body as their complete final content: drop the restated keeper from the body, or widen the range to consume it."
    )
}

/// 両側境界echo修復の警告。
pub fn boundary_echo_two_sided_warning(start: u32, leading: usize, trailing: usize) -> String {
    format!(
        "Auto-repaired a replacement boundary echo at line {start}: dropped {leading} leading and {trailing} trailing payload line(s) already present outside the range. Issue the payload as the final desired content for the selected range only — never restate unchanged lines bordering the range."
    )
}

/// 片側境界echo修復の警告。
pub fn boundary_echo_one_sided_warning(start: u32, count: usize, side: &str) -> String {
    let (side_name, position) = if side == "leading" {
        ("leading", "above")
    } else {
        ("trailing", "below")
    };
    format!(
        "Auto-repaired a replacement boundary echo at line {start}: dropped {count} {side_name} payload line(s) identical to the surviving line(s) just {position} the range. The range was one line short of the content you retyped — issue the payload as the final content for the selected range only, and widen the range to consume any keeper you restate."
    )
}
