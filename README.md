# LITRA

LITRA は、長編小説および連作の制作を支援する執筆アプリケーションです。本文、設定資料、エピソード要約、メモ、ジャンル知識をすべてローカルに保存します。

## インストール

GitHub Releases から最新版をダウンロードしてインストールします。

- `LITRA_x64-setup.exe`（NSIS インストーラ）
- `LITRA_x64_en-US.msi`（MSI パッケージ）

インストール後、スタートメニューから LITRA を起動します。

## 初期設定

AI 機能を使用するには、設定画面（歯車ボタン）で AI プロバイダーと API キーを設定します。

- OpenAI、Anthropic、DeepSeek、Google Gemini などの対応プロバイダーの API キーを入力します
- llama.cpp などのローカルサーバーを使用する場合は、ベース URL に `http://127.0.0.1:8080/v1` を指定します

## 基本的な使い方

1. プロジェクトを作成します
2. エピソードを追加し、本文を執筆します
3. チャットパネルに「続きを書いて」などと入力すると、AI が本文の続きを提案します
4. エピソード要約、一行要約、メモを保存し、作品情報を蓄積します

## 機能一覧

- プロジェクト単位の小説管理（エピソードの追加・並び替え・削除）
- エピソード要約と一行要約の生成・保存
- キャラクター、世界観、人間関係の設定管理
- チャットからの本文検索、行指定編集、一括編集、整合性チェック
- フォルダ取り込みによる本文・設定の分類と変換
- ジャンルライブラリによる参考資料、分析結果、ジャンル知識の管理
- メイン画面、チャット、要約、メモ、設定、ジャンル画面の分離ウィンドウ

## 上級者向け設定

### AI プロバイダーの詳細設定

初期設定では以下のプロバイダー設定を持っています。

- OpenAI
- Anthropic
- DeepSeek
- Google Gemini
- llama.cpp 互換ローカルサーバー
- さくらの AI Engine
- PLaMo
- OpenCode Go

API キー、ベース URL、モデル、temperature、最大出力トークン、コンテキスト上限、reasoning / thinking 関連の設定はアプリ内の設定画面から変更できます。

Web 検索は設定画面の「検索ツールの優先順位」で候補を並べ替えられます。既定では、選択中のプロバイダーが対応するネイティブ検索（OpenAI Responses / Anthropic Messages / Gemini Google Search）を優先し、Exa を共通フォールバックとして使用します。Gemini 3 では Google Search とアプリのカスタムツールを併用し、それ以前の現行 Gemini モデルでは単独のネイティブ検索として利用します。Codex、Copilot、OpenCode、DeepSeek、さくらの AI Engine、PLaMo、llama.cpp には、現行の公開 API 仕様で確認できるネイティブ Web 検索を割り当てていません。

### providers.json によるカスタマイズ

プロバイダーとモデルの定義は、初回起動時にアプリ設定ディレクトリへ書き出される `providers.json` で自由にカスタマイズできます（ビルド後も編集可能）。

- Windows: `%APPDATA%\org.hmbm.litra\providers.json`
- macOS: `~/Library/Application Support/org.hmbm.litra/providers.json`
- Linux: `~/.config/org.hmbm.litra/providers.json`

プロバイダーごとの主な設定項目:

| フィールド | 説明 |
| --- | --- |
| `id` / `name` | プロバイダーの識別子と表示名 |
| `endpoints` | 同じ Provider で選択できる複数の接続先。各要素に `id` / `apiType` / `baseUrl` を指定 |
| `apiType` | `openai-chat` / `openai-responses` / `anthropic-messages` / `google-generate-content` |
| `defaultBaseUrl` / `defaultModel` | 既定のベース URL とモデル |
| `requiresApiKey` | API キー必須かどうか |
| `modelSelection` | `fixed`: `models` からの固定選択（取得ボタン無効） / `fetch`: 自由入力＋モデル一覧取得 API を使用 |
| `modelsPolicy` | `merge`: アプリ更新時に既定モデルを id 単位でマージ（既定） / `replace`: このファイルの `models` をそのまま使う |
| `models` | モデルごとの既定値（`id` / `label` / `temperature` / `maxTokens` / `maxContextTokens` / `topP` / `topK` / `frequencyPenalty` / `presencePenalty` / reasoning・thinking 関連） |

編集内容はアプリ側の既定値より優先されます。既定モデル一覧の自動追加を止めたい場合は該当プロバイダーに `"modelsPolicy": "replace"` を指定してください。ファイルを削除するか、設定画面の初期化を実行すると、次回起動時に既定の内容で再作成されます。

### 開発

必要なもの:

- Rust（`wasm32-unknown-unknown` ターゲットを含む）
- Trunk
- Tauri 2 のビルドに必要な OS 別依存関係

コマンド:

```bash
rustup target add wasm32-unknown-unknown
cargo install trunk
cargo install tauri-cli --version "^2.0.0" --locked
trunk serve --port 1420
cargo tauri dev
```

リリース用フロントエンドは `trunk build --release`、Rust バックエンドは `cargo test --manifest-path src-tauri/Cargo.toml` で検証できます。Node.js、Bun、Vite は使用しません。

### 構成

- `frontend-rs/src/`: 全画面の Rust/WASM フロントエンド、UI、AI クライアント
- `src-tauri/`: Tauri アプリ本体、ファイル操作、検索、インポート、AI ツール用コマンド
- `config/default-providers.json`: API Type と複数接続先を含む初期 AI プロバイダー・モデル定義（ビルド時にバイナリへ埋め込み、インストーラにも同梱）
- `frontend-rs/src/windows/`: 画面単位に分割した Rust UI 実装
- `frontend-rs/src/runtime/`: AI ストリーム、Tauri invoke、ウィンドウ間イベントの Rust ランタイム

## 特記事項

### データの保存場所

- プロジェクト: `Documents/litra/projects`
- ジャンルライブラリ: `Documents/litra/genres`

### 設定ファイルの場所

| 内容 | 場所 |
| --- | --- |
| アプリ設定（選択中プロバイダー・モデル等） | `%APPDATA%\org.hmbm.litra\litra-settings.json` |
| プロバイダー定義（初回起動時に自動作成） | `%APPDATA%\org.hmbm.litra\providers.json` |
| API キー | OS の資格情報ストア（Windows では資格情報マネージャー） |
| モデル一覧キャッシュ | `%APPDATA%\org.hmbm.litra\ai-model-catalog.json` |

設定の読み込み優先順位は、ユーザーの `providers.json`（カスタム定義）が最も優先され、次にインストーラ同梱の `config/default-providers.json`、最後にバイナリ埋め込みの既定値が使われます。

### 検索インデックス

検索インデックスはアプリデータディレクトリ配下の `litra/index` と `litra/genre-index` を使います。インデックスは再構築可能な派生データです。

### 初期化について

設定画面の「初期化」を実行すると、AI・同期・ウィンドウ設定と全 API キーが削除され、既定値に戻ります。`providers.json` も削除され、次回起動時に既定の内容で再作成されます。作品データ（`Documents/litra`）は影響を受けません。
