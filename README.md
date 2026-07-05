# LITRA

LITRA は、長編小説や連作の制作を前提にした、リトラと一緒に進める執筆ツールです。Tauri 2、Vite、TypeScript、Rust で構成され、本文、設定資料、エピソード要約、メモ、ジャンル知識をローカルに保存します。

## 主な機能

- プロジェクト単位の小説管理
- エピソード本文の編集、並び替え、削除
- エピソード要約と一行要約の保存
- エピソード別の覚え書きとプロジェクトメモ
- キャラクター、世界観、人間関係の設定管理
- リトラチャットからの本文検索、行指定編集、一括編集、整合性チェック
- フォルダ取り込みによる本文・設定の分類と変換
- 取り込み後の任意の整合性チェック
- ジャンルライブラリによる参考資料、分析結果、再利用可能なジャンル知識の管理
- ジャンルごとのリトラチャットと添付長文の保存
- メイン画面、チャット、要約、メモ、設定、ジャンル画面の分離ウィンドウ

## AI プロバイダー

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

### プロバイダー設定のカスタマイズ（providers.json）

プロバイダーとモデルの定義は、初回起動時にアプリ設定ディレクトリへ書き出される `providers.json` で自由にカスタマイズできます（ビルド後も編集可能）。

- Windows: `%APPDATA%\org.hmbm.litra\providers.json`
- macOS: `~/Library/Application Support/org.hmbm.litra/providers.json`
- Linux: `~/.config/org.hmbm.litra/providers.json`

プロバイダーごとの主な設定項目:

| フィールド | 説明 |
| --- | --- |
| `id` / `name` | プロバイダーの識別子と表示名 |
| `sdkType` | `openai`（OpenAI 互換） / `anthropic` / `google` |
| `defaultBaseUrl` / `defaultModel` | 既定のベース URL とモデル |
| `requiresApiKey` | API キー必須かどうか |
| `modelSelection` | `fixed`: `models` からの固定選択（取得ボタン無効） / `fetch`: 自由入力＋モデル一覧取得 API を使用 |
| `modelsPolicy` | `merge`: アプリ更新時に既定モデルを id 単位でマージ（既定） / `replace`: このファイルの `models` をそのまま使う |
| `models` | モデルごとの既定値（`id` / `label` / `temperature` / `maxTokens` / `maxContextTokens` / `topP` / `topK` / `frequencyPenalty` / `presencePenalty` / reasoning・thinking 関連） |

編集内容はアプリ側の既定値より優先されます。既定モデル一覧の自動追加を止めたい場合は該当プロバイダーに `"modelsPolicy": "replace"` を指定してください。ファイルを削除するか、設定画面の初期化を実行すると既定の内容に戻ります。

## データ保存

作品データはユーザーの Documents 配下に保存されます。

- プロジェクト: `Documents/litra/projects`
- ジャンルライブラリ: `Documents/litra/genres`

検索インデックスはアプリデータディレクトリ配下の `litra/index` と `litra/genre-index` を使います。インデックスは再構築可能な派生データです。

## 開発

必要なもの:

- Bun
- Rust
- Tauri 2 のビルドに必要な OS 別依存関係

コマンド:

```bash
bun install
bun run dev
bun run build
bun run tauri dev
```

`bun run build` は TypeScript の型チェックと Vite のビルドを実行します。

## 構成

- `src/`: フロントエンド、AI サービス、プロジェクト管理、ジャンル管理
- `src-tauri/`: Tauri アプリ本体、ファイル操作、検索、インポート、AI ツール用コマンド
- `src/providers/default-providers.json`: 初期 AI プロバイダーとモデル定義
- `src/ai/tools.ts`: リトラチャットから使える本文編集、検索、要約、設定更新ツール
