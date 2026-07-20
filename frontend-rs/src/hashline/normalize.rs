//! 改行コード・BOM の正規化。oh-my-pi `normalize.ts` の移植。

/// ファイルの改行コード。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineEnding {
    Lf,
    CrLf,
}

/// 最初に現れる `\r\n` と `\n` のうち早い方で改行コードを判定する（デフォルト LF）。
pub fn detect_line_ending(content: &str) -> LineEnding {
    let lf_idx = content.find('\n');
    let crlf_idx = content.find("\r\n");
    match (lf_idx, crlf_idx) {
        (None, _) => LineEnding::Lf,
        (_, None) => LineEnding::Lf,
        (Some(lf), Some(crlf)) => {
            if crlf < lf {
                LineEnding::CrLf
            } else {
                LineEnding::Lf
            }
        }
    }
}

/// CRLF および単独の CR を LF に正規化する（TS: `text.replace(/\r\n?/g, "\n")`）。
pub fn normalize_to_lf(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let bytes = text.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\r' => {
                out.push('\n');
                // `\r\n` は1つの LF にまとめる
                if i + 1 < bytes.len() && bytes[i + 1] == b'\n' {
                    i += 1;
                }
                i += 1;
            }
            _ => {
                // 通常の文字。UTF-8 の境界を壊さないよう char 単位で進める。
                let ch_start = i;
                i += 1;
                while i < bytes.len() && (bytes[i] & 0xC0) == 0x80 {
                    i += 1;
                }
                out.push_str(&text[ch_start..i]);
            }
        }
    }
    out
}

/// 検出済みの改行コードを復元する。
pub fn restore_line_endings(text: &str, ending: LineEnding) -> String {
    match ending {
        LineEnding::Lf => text.to_string(),
        LineEnding::CrLf => text.replace('\n', "\r\n"),
    }
}

/// BOM 除去の結果。
pub struct BomResult {
    pub bom: &'static str,
    pub text: String,
}

/// 先頭の UTF-8 BOM を取り除く。
pub fn strip_bom(content: &str) -> BomResult {
    if let Some(rest) = content.strip_prefix('\u{FEFF}') {
        BomResult {
            bom: "\u{FEFF}",
            text: rest.to_string(),
        }
    } else {
        BomResult {
            bom: "",
            text: content.to_string(),
        }
    }
}
