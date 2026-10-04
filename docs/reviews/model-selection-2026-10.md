# AI モデル選定と接続互換性

確認日: **2026-10-04 UTC**。公式公開資料とローカル回帰試験に基づく。
API キー・OAuth・課金 API は使っていない。実アカウントの権限、稼働状況、
日本語小説の品質・速度は未検証であり、最新モデルが常に最良とは限らない。

## 今回のカタログ

|接続|標準候補|低コスト候補|今回の扱い|
|---|---|---|---|
|OpenAI API|`gpt-6.1-sol`|`gpt-6-luna`|追加。新規既定 Sol / medium、Luna / low。両方 Responses|
|Google API|`gemini-3.8-flash`|`gemini-3.5-flash-lite`|3.8 を追加。新規既定 3.8 / medium。Lite / low を上位表示|
|DeepSeek API|`deepseek-flash` (V4.1 Flash)|同左|正式 ID を追加し新規既定に。high を使用し max 常用を避ける|
|Anthropic API|`claude-sonnet-5`|既存 Haiku 4.5|新規既定を Fable 5 から互換 Sonnet 5 に。5.5 は下記条件のため保留|
|PLaMo / さくら / llama.cpp|既存設定|既存設定|接続先が公表していない能力を推測せず維持|
|Codex / Copilot / OpenCode Go|既存設定・アカウントの一覧|契約・用途依存|公開 API の最新 ID をコピーしない。今回カタログは変更なし|

新規既定は既存設定ファイルの defaultModel や保存済み選択モデルを上書きしない。
旧モデル ID、カスタムモデル・URL・能力設定・役割指定も残す。
モデル一覧は ID で追加・マージする。既存の `modelsPolicy: "replace"` は
今回から正しく尊重し、空リストを含めその利用者の一覧だけを使う。
カタログの label / reasoningCapability / 独自フィールドを first-run の保存や
GUI への返却で落としていた問題も修正した。

## 対応済みの組み合わせ

- Sol: effort は low / medium / high / xhigh / max。none / minimal は送信前にエラー。
  ツールありは Responses。Chat はツールなしのみ。
- Luna: 上記に none を追加。Chat でツールを使う場合は明示的に none。
  未指定時は API の medium なので、Chat + tools はローカルで拒否する。
- 新 OpenAI 2 モデル: reasoning 有効時は temperature / top_p を送らない。
  Chat の出力上限には max_completion_tokens を使い、互換他社 API の
  max_tokens は維持する。変更された値を設定ファイルへ書き戻す処理はない。
- Gemini 3.8: low / medium / high のみ。保存済み minimal などは送信前に
  対応値の選択を求める。3.5 Flash-Lite は minimal を引き続き使用可能。
- DeepSeek: deepseek-flash と deepseek-v4.1-* を V4 系として認識する。
  日本語出力のための既存 Thinking 固定を維持し、low / high / max を送信できる。
  ツール強制指定は Thinking と両立しないのでローカルで拒否し、通常ループは auto。
  履歴の reasoning_content と tool call/result を引き継ぐ。
- 設定値の OpenAI effort が DeepSeek に漏れないよう、プロバイダーに合う設定を
  解決する。役割ごとの明示 effort は通常設定より優先する。

これらの制約は確認できた直接 API のモデルに限定する。未知のカスタム ID や
サブスク配下の同名モデルに、直接 API の権限・制約を勝手に適用しない。

## 保留と理由

Claude Sonnet / Opus 5.5 は最新だが、単なる ID 変更では安全に移行できない。
強制 tool_choice、thinking 無効化、sampling に互換性変更があるほか、
署名付き thinking は過去の会話・system・tools に結び付く。LITRA の動的な
原稿コンテキスト再構築と整合する append-only 履歴の設計・回帰検証が必要。
5.5 は今回の推奨カタログに追加しない。モデル取得で表示されても検証済みの意味ではない。
Sonnet 5 は互換候補であり、最新という表記をしない。

Codex の既存 OAuth 接続は legacy backend-api/codex 向け。最新の公開
Sign in with ChatGPT は別の登録・scope・公開 /v1/responses・利用者別モデル一覧を
使うため、既存トークンの転用や base URL だけの変更をしない。
Copilot は認証済みカタログを優先する。OpenCode Go は coding 向けサービスであり、
小説用途の無条件の標準推奨にはしない。いずれも月額枠と API 従量料金は別物。

## コストを抑える使い分け

本文・複雑な整合性判断は Sol または Flash、短い要約・分類・背景処理は
Luna または Flash-Lite を比較する出発点とする。利用者が明示的に各役割で選ぶ。
プログラムが勝手に他社モデル・API 課金へ切り替える変更はない。

標準入力 / 出力の参考 USD 価格（各 100 万 token）:

- Sol: $2 / $10、Luna: $0.10 / $0.50。入力 272K 超、cache、Fast 等は料金条件が異なる
- Gemini 3.8: 2026-12-31 まで $0.75 / $3.75、2027-01-01 から $1.50 / $7.50
- Gemini 3.5 Flash-Lite: $0.30 / $2.50
- DeepSeek Flash: off-peak $0.15 / $0.60、peak $0.30 / $1.20

カタログの maxTokens は従来から「能力上限」と「設定省略時のリクエスト上限」を
兼ねる。今回はこの契約を変えず、128K / 65,536 / 384,000 を維持する。
DeepSeek の公式最大値は 393,216 だが、既存の安全側 384,000 を踏襲する。
最大値は推奨出力予算や費用保証ではない。明示された少ない maxTokens は尊重し、
モデル上限を超える値のみクランプする。複数候補・レビュー・再試行・ツール往復・
thinking token により一作業で複数回分の料金になる。新しい数値の自動引き下げより、
代表的な原稿で品質、JSON 成功率、修正回数、総 token、待ち時間を測ることを優先する。

## 検証

- production の request builder / transport / config / models を直接取り込んだ
  headless harness で、対応・非対応 effort、ツール、protocol、sampling、
  DeepSeek reasoning 履歴、送信前拒否、カタログの新既定とユーザー選択維持を試験
- frontend の能力・オプション・tool choice と既存回帰試験
- ローカル mock / pure tests の結果であり、実サービスへの接続成功を意味しない
- Tauri 全体は環境の GLib/GTK 不足で未検証。GUI の実操作は別の検証範囲

## 公式資料

- [OpenAI Sol モデル](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
- [OpenAI Luna モデル](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [GPT-6 移行・sampling](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra)
- [Chat Completions パラメータ](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Gemini 3.8 Flash](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash)
- [Gemini 3.5 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)
- [Google 料金](https://ai.google.dev/gemini-api/docs/pricing)
- [DeepSeek モデル・料金](https://api-docs.deepseek.com/quick_start/pricing/)
- [DeepSeek Chat パラメータ](https://api-docs.deepseek.com/api/create-chat-completion/)
- [Claude Sonnet 5.5 移行](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide)
- [Claude Opus 5.5](https://platform.claude.com/docs/en/models/opus-5-5/overview)
- [ChatGPT 公開 OAuth 推論](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Copilot 対応モデル](https://docs.github.com/en/copilot/reference/ai-models/supported-models)
- [OpenCode Go](https://opencode.ai/docs/go/)
