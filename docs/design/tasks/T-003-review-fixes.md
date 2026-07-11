# T-003: Fix final review findings

## Requirements
1. Fix Copilot protocol routing: current `createModel` always uses Chat and ignores cached endpoint metadata. Use `getCopilotModelEndpoint(settings.model)` to select Anthropic Messages (`createAnthropic` with Copilot base `/v1` and Copilot fetch), OpenAI Responses, or OpenAI Chat. Ensure metadata lookup is populated by dynamic model fetch and has sensible fallback for configured known models. Match sample behavior.
2. Load/preserve `openaiReasoningEffort` when active provider is `codex`, not only `openai`.
3. Tighten Copilot `/models` parsing to require usable limits/tool-call capability and honor `model_picker_enabled`, as in sample.
4. Add friendly OAuth-login validation to `genre-chat-window.ts` if that path can select these providers.
5. Run build, cargo check, diff check. Keep scope limited.
