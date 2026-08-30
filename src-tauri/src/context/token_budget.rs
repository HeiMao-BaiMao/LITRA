//! Token budget management and auto-compaction (inspired by Codex's token_budget_context).

use serde::Deserialize;
use serde::Serialize;

/// Tracks token usage and triggers compaction when budget is low.
#[derive(Clone, Debug)]
pub struct TokenBudget {
    /// Maximum context tokens for the current model.
    pub max_context_tokens: usize,
    /// Threshold ratio (0.0-1.0) below which auto-compaction triggers.
    pub compaction_threshold: f64,
    /// Current estimated token count.
    current_tokens: usize,
    /// Whether auto-compaction is enabled.
    auto_compact_enabled: bool,
}

impl TokenBudget {
    pub fn new(max_context_tokens: usize) -> Self {
        Self {
            max_context_tokens,
            compaction_threshold: 0.8,
            current_tokens: 0,
            auto_compact_enabled: true,
        }
    }

    pub fn with_threshold(mut self, threshold: f64) -> Self {
        self.compaction_threshold = threshold.clamp(0.5, 0.95);
        self
    }

    pub fn with_auto_compact(mut self, enabled: bool) -> Self {
        self.auto_compact_enabled = enabled;
        self
    }

    /// Update the current token count.
    pub fn update_tokens(&mut self, tokens: usize) {
        self.current_tokens = tokens;
    }

    /// Add tokens to the current count.
    pub fn add_tokens(&mut self, tokens: usize) {
        self.current_tokens += tokens;
    }

    /// Return the current usage ratio (0.0-1.0).
    pub fn usage_ratio(&self) -> f64 {
        if self.max_context_tokens == 0 {
            return 0.0;
        }
        self.current_tokens as f64 / self.max_context_tokens as f64
    }

    /// Check if compaction should be triggered.
    pub fn should_compact(&self) -> bool {
        if !self.auto_compact_enabled {
            return false;
        }
        self.usage_ratio() >= self.compaction_threshold
    }

    /// Remaining tokens before hitting the limit.
    pub fn tokens_remaining(&self) -> usize {
        self.max_context_tokens.saturating_sub(self.current_tokens)
    }

    /// Reset after compaction.
    pub fn reset_after_compaction(&mut self, new_token_count: usize) {
        self.current_tokens = new_token_count;
    }
}

/// Estimate token count from character count (rough heuristic).
/// English: ~4 chars/token, Japanese: ~1.5-2 chars/token.
pub fn estimate_tokens(text: &str) -> usize {
    let japanese_chars: usize = text
        .chars()
        .filter(|c| {
            let cp = *c as u32;
            matches!(cp,
                0x3000..=0x303F | // CJK symbols/punctuation
                0x3040..=0x309F | // Hiragana
                0x30A0..=0x30FF | // Katakana
                0x4E00..=0x9FFF | // CJK unified
                0xFF00..=0xFFEF   // Fullwidth forms
            )
        })
        .count();
    let other_chars = text.chars().count() - japanese_chars;
    // Japanese: ~2 chars/token, others: ~4 chars/token
    (japanese_chars + 1) / 2 + (other_chars + 3) / 4
}

/// Configuration for context window management.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ContextWindowConfig {
    pub schema_version: u32,
    /// Max tokens to preserve as recent history during compaction.
    pub preserved_recent_tokens: usize,
    /// Minimum messages to always keep.
    pub min_preserved_messages: usize,
}

impl Default for ContextWindowConfig {
    fn default() -> Self {
        Self {
            schema_version: 1,
            preserved_recent_tokens: 8_000,
            min_preserved_messages: 4,
        }
    }
}

/// A single message in the conversation history with token tracking.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TrackedMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub tokens: usize,
}

impl TrackedMessage {
    pub fn new(role: impl Into<String>, content: impl Into<String>) -> Self {
        let content = content.into();
        let tokens = estimate_tokens(&content);
        Self {
            role: role.into(),
            content,
            tokens,
        }
    }
}

/// Manages conversation history with automatic compaction.
#[derive(Clone, Debug, Default)]
pub struct ConversationHistory {
    messages: Vec<TrackedMessage>,
    config: ContextWindowConfig,
    budget: Option<TokenBudget>,
}

impl ConversationHistory {
    pub fn new(config: ContextWindowConfig) -> Self {
        Self {
            messages: Vec::new(),
            config,
            budget: None,
        }
    }

    pub fn with_budget(mut self, budget: TokenBudget) -> Self {
        self.budget = Some(budget);
        self
    }

    pub fn add(&mut self, role: impl Into<String>, content: impl Into<String>) {
        let msg = TrackedMessage::new(role, content);
        if let Some(budget) = &mut self.budget {
            budget.add_tokens(msg.tokens);
        }
        self.messages.push(msg);
    }

    /// Check if compaction is needed.
    pub fn needs_compaction(&self) -> bool {
        self.budget.as_ref().map_or(false, |b| b.should_compact())
    }

    /// Total tokens in history.
    pub fn total_tokens(&self) -> usize {
        self.messages.iter().map(|m| m.tokens).sum()
    }

    /// Get messages for sending to AI, applying compaction if needed.
    pub fn prepare_for_send(&self) -> &[TrackedMessage] {
        if !self.needs_compaction() {
            return &self.messages;
        }
        // In a real implementation, this would return a compacted version
        // For now, return all messages
        &self.messages
    }

    /// Compact history: summarize old messages, keep recent ones.
    pub fn compact(&mut self, summary: String) -> CompactionResult {
        let total_before = self.total_tokens();
        let msg_count_before = self.messages.len();

        // Keep recent messages up to preserved_recent_tokens
        let mut preserved_tokens = 0;
        let mut split_idx = self.messages.len();
        for (i, msg) in self.messages.iter().enumerate().rev() {
            if preserved_tokens + msg.tokens > self.config.preserved_recent_tokens
                || (self.messages.len() - i) > self.config.min_preserved_messages
            {
                if (self.messages.len() - i) >= self.config.min_preserved_messages {
                    split_idx = i + 1;
                    break;
                }
            }
            preserved_tokens += msg.tokens;
        }

        // Build compacted history: summary + preserved recent
        let mut compacted = Vec::new();
        compacted.push(TrackedMessage::new("user", format!(
            "以下は以前の会話の要約:\n{}\n\nこの続きから執筆を続けます。",
            summary
        )));
        compacted.extend(self.messages[split_idx..].iter().cloned());

        let tokens_after = compacted.iter().map(|m| m.tokens).sum();

        self.messages = compacted;
        if let Some(budget) = &mut self.budget {
            budget.reset_after_compaction(tokens_after);
        }

        CompactionResult {
            messages_before: msg_count_before,
            messages_after: self.messages.len(),
            tokens_before: total_before,
            tokens_after,
        }
    }

    pub fn messages(&self) -> &[TrackedMessage] {
        &self.messages
    }

    pub fn clear(&mut self) {
        self.messages.clear();
        if let Some(budget) = &mut self.budget {
            budget.update_tokens(0);
        }
    }
}

/// Result of a compaction operation.
#[derive(Clone, Debug)]
pub struct CompactionResult {
    pub messages_before: usize,
    pub messages_after: usize,
    pub tokens_before: usize,
    pub tokens_after: usize,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_estimate_tokens_english() {
        let text = "Hello world, this is a test.";
        let tokens = estimate_tokens(text);
        // ~25 chars / 4 = ~6 tokens
        assert!(tokens >= 4 && tokens <= 10);
    }

    #[test]
    fn test_estimate_tokens_japanese() {
        let text = "こんにちは世界、これはテストです。";
        let tokens = estimate_tokens(text);
        // ~16 japanese chars / 2 = ~8 tokens
        assert!(tokens >= 5 && tokens <= 12);
    }

    #[test]
    fn test_token_budget() {
        let mut budget = TokenBudget::new(1000).with_threshold(0.8);
        budget.update_tokens(500);
        assert!(!budget.should_compact());
        budget.update_tokens(850);
        assert!(budget.should_compact());
    }

    #[test]
    fn test_conversation_history_compaction() {
        let config = ContextWindowConfig {
            preserved_recent_tokens: 100,
            min_preserved_messages: 2,
            ..Default::default()
        };
        let budget = TokenBudget::new(1000).with_threshold(0.5);
        let mut history = ConversationHistory::new(config).with_budget(budget);

        // Add many messages with enough content to trigger compaction
        for i in 0..40 {
            history.add("user", format!("Message {} with some content to make it longer for testing", i));
            history.add("assistant", format!("Response {} with some content to make it longer for testing", i));
        }

        assert!(history.needs_compaction());

        let result = history.compact("Previous conversation summary".to_string());
        assert!(result.messages_after < result.messages_before);
        assert!(result.tokens_after < result.tokens_before);
    }
}
