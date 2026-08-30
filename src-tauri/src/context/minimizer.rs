//! Tool output compaction (inspired by oh-my-pi's minimizer system).
//!
//! Before sending tool results back to the AI, compact large outputs to save
//! tokens in the context window.

/// Configuration for output compaction.
#[derive(Clone, Debug)]
pub struct MinimizerConfig {
    /// Enable compaction globally.
    pub enabled: bool,
    /// Minimum output length before compaction kicks in (chars).
    pub min_chars: usize,
    /// Maximum lines to show before eliding.
    pub max_lines: usize,
    /// Maximum chars per line before truncation.
    pub max_line_length: usize,
}

impl Default for MinimizerConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            min_chars: 1_000,
            max_lines: 50,
            max_line_length: 300,
        }
    }
}

/// Compact a tool's output for AI consumption.
pub fn compact_output(input: &str, config: &MinimizerConfig) -> String {
    if !config.enabled || input.len() < config.min_chars {
        return input.to_string();
    }

    let lines: Vec<&str> = input.lines().collect();
    if lines.len() <= config.max_lines {
        // Under line limit, just truncate long lines
        return lines
            .iter()
            .map(|line| {
                if line.len() > config.max_line_length {
                    format!("{}...(truncated)", &line[..config.max_line_length])
                } else {
                    line.to_string()
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
    }

    // Over line limit: show head + elision + tail
    let head_lines = config.max_lines / 2;
    let tail_lines = config.max_lines - head_lines;
    let elided = lines.len() - config.max_lines;

    let mut result = String::new();
    for line in &lines[..head_lines] {
        result.push_str(&truncate_line(line, config.max_line_length));
        result.push('\n');
    }
    result.push_str(&format!(
        "\n...[{} lines elided]...\n\n",
        elided
    ));
    for line in &lines[lines.len() - tail_lines..] {
        result.push_str(&truncate_line(line, config.max_line_length));
        result.push('\n');
    }
    result
}

fn truncate_line(line: &str, max_len: usize) -> String {
    if line.len() > max_len {
        format!("{}...(truncated)", &line[..max_len])
    } else {
        line.to_string()
    }
}

/// Compact search results: keep top N + summary.
pub fn compact_search_results(results: &[SearchResult], max_results: usize) -> String {
    if results.len() <= max_results {
        return serde_json::to_string_pretty(results).unwrap_or_default();
    }

    let mut output = format!("{} results found. Top {}:\n\n", results.len(), max_results);
    for (i, result) in results.iter().take(max_results).enumerate() {
        output.push_str(&format!(
            "{}. **{}**\n   {}\n\n",
            i + 1,
            result.title,
            result
                .snippet
                .chars()
                .take(200)
                .collect::<String>()
        ));
    }
    output
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct SearchResult {
    pub title: String,
    pub url: String,
    pub snippet: String,
}

/// Compact a file listing: summarize by type/count.
pub fn compact_file_listing(paths: &[String], max_shown: usize) -> String {
    if paths.len() <= max_shown {
        return paths.join("\n");
    }

    let shown = paths[..max_shown].join("\n");
    format!(
        "{}\n\n...[{} more files elided, {} total]",
        shown,
        paths.len() - max_shown,
        paths.len()
    )
}

/// Tabular data compaction (inspired by oh-my-pi's table compaction).
pub fn compact_table(rows: &[Vec<String>], max_rows: usize) -> String {
    if rows.is_empty() {
        return String::new();
    }
    if rows.len() <= max_rows {
        return rows
            .iter()
            .map(|row| row.join(" | "))
            .collect::<Vec<_>>()
            .join("\n");
    }

    let head = rows.len().min(max_rows / 2);
    let tail = max_rows - head;
    let elided = rows.len() - max_rows;

    let mut output = String::new();
    for row in &rows[..head] {
        output.push_str(&row.join(" | "));
        output.push('\n');
    }
    output.push_str(&format!("...[{} rows elided]...\n", elided));
    for row in &rows[rows.len() - tail..] {
        output.push_str(&row.join(" | "));
        output.push('\n');
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compact_output_short() {
        let config = MinimizerConfig::default();
        let input = "short output";
        assert_eq!(compact_output(input, &config), input);
    }

    #[test]
    fn test_compact_output_long() {
        let config = MinimizerConfig {
            min_chars: 10,
            max_lines: 5,
            ..Default::default()
        };
        let input = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8";
        let result = compact_output(input, &config);
        assert!(result.contains("elided"));
        assert!(result.contains("line1"));
        assert!(result.contains("line8"));
    }

    #[test]
    fn test_compact_output_disabled() {
        let config = MinimizerConfig {
            enabled: false,
            ..Default::default()
        };
        let input = "a".repeat(10_000);
        assert_eq!(compact_output(&input, &config), input);
    }

    #[test]
    fn test_truncate_line() {
        assert_eq!(truncate_line("short", 10), "short");
        assert_eq!(
            truncate_line("a".repeat(100).as_str(), 50),
            format!("{}...(truncated)", "a".repeat(50))
        );
    }
}
