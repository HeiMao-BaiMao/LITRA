/**
 * ChatGPT Codex プロバイダーの OAuth デバイスフロー・トークン管理・API fetch ラッパー。
 * サンプル実装 sample/opencode/…/codex.ts を正確にトレースする。
 */

import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  startDeviceAuth,
  pollDeviceToken,
} from "./oauth-helpers.ts";
import {
  readOAuthCredential,
  writeOAuthCredential,
} from "../secrets.ts";

// ---- サンプル準拠の定数 ----

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
export const CODEX_API_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const OAUTH_POLLING_TIMEOUT_MS = 5 * 60 * 1_000;

/** Codex で許可するモデル一覧。サンプルの ALLOWED_MODELS 準拠。 */
const ALLOWED_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
]);

const DISALLOWED_MODELS = new Set(["gpt-5.5-pro"]);

// ---- 型 ----

export interface CodexCredential {
  [key: string]: unknown;
  access: string;
  refresh: string;
  expires: number; // Date.now() + expires_in * 1000
  accountId?: string;
}

interface TokenResponse {
  id_token?: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

// ---- JWT claims 解析（サンプル準拠） ----

interface IdTokenClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  email?: string;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
}

function base64UrlDecode(str: string): string {
  try {
    return atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return "";
  }
}

function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(base64UrlDecode(parts[1]));
  } catch {
    return undefined;
  }
}

function extractAccountIdFromTokens(tokens: TokenResponse): string | undefined {
  // id_token から優先抽出
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token);
    if (claims) {
      const id =
        claims.chatgpt_account_id ??
        claims["https://api.openai.com/auth"]?.chatgpt_account_id ??
        claims.organizations?.[0]?.id;
      if (id) return id;
    }
  }
  // access_token からフォールバック抽出
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token);
    if (claims) {
      return (
        claims.chatgpt_account_id ??
        claims["https://api.openai.com/auth"]?.chatgpt_account_id ??
        claims.organizations?.[0]?.id
      );
    }
  }
  return undefined;
}

// ---- キーリング I/O ----

const CREDENTIAL_PROVIDER = "codex" as const;

export async function readCodexCredential(): Promise<CodexCredential | undefined> {
  return readOAuthCredential<CodexCredential>(CREDENTIAL_PROVIDER);
}

async function saveCodexCredential(cred: CodexCredential): Promise<void> {
  await writeOAuthCredential(CREDENTIAL_PROVIDER, cred);
}

export async function deleteCodexCredential(): Promise<void> {
  await writeOAuthCredential(CREDENTIAL_PROVIDER, undefined);
}

// ---- ブラウザ PKCE OAuth（既定のログイン方式、サンプルの browser メソッド準拠） ----

/**
 * PKCE ブラウザフローで Codex にログインする。
 * Rust 側でローカルコールバックサーバーを起動し、PKCE 認可コードフロー全体を
 * 処理する。成功したら credential をキーリングに保存し、読み取り直して返す。
 * キャンセルは cancel_codex_browser_auth 経由で行う。
 */
export async function loginWithBrowserCode(
  signal: AbortSignal,
): Promise<CodexCredential> {
  // Rust コマンドを起動（キャンセル信号を伝達）
  const promise = invoke<{ success: boolean; message: string }>(
    "start_codex_browser_auth",
  );

  // キャンセル時は Rust 側の cancel コマンドを呼ぶ
  const cancelHandler = () => {
    invoke("cancel_codex_browser_auth").catch(() => {});
  };
  if (signal.aborted) {
    cancelHandler();
    throw new Error("ログインがキャンセルされました。");
  }
  signal.addEventListener("abort", cancelHandler, { once: true });

  let result: { success: boolean; message: string };
  try {
    result = await promise;
  } finally {
    signal.removeEventListener("abort", cancelHandler);
  }

  if (!result.success) {
    throw new Error(result.message);
  }

  // キーリングから credential を読み取って返す
  const cred = await readCodexCredential();
  if (!cred) {
    throw new Error("認証後に credential が見つかりませんでした。");
  }
  return cred;
}

// ---- デバイス OAuth（サンプルの headless メソッド準拠、内部フォールバック） ----

export async function loginWithDeviceCode(
  signal: AbortSignal,
  onUserCode?: (code: string, verificationUri: string) => void,
): Promise<CodexCredential> {
  // 1. デバイスコード発行
  const device = await startDeviceAuth(
    `${ISSUER}/api/accounts/deviceauth/usercode`,
    { client_id: CLIENT_ID },
  );

  // 2. 確認 URL をブラウザで開く
  const verificationUrl = `${ISSUER}/codex/device`;
  await openUrl(verificationUrl).catch(() => {
    // 失敗しても続行（ユーザーが手動で開けるようにコードを表示する）
  });

  // ユーザーコードを表示するコールバック（UI 側で表示するため）
  onUserCode?.(device.userCode, verificationUrl);

  // 3. ポーリングで authorization_code を取得
  const timeoutSignal = AbortSignal.timeout(OAUTH_POLLING_TIMEOUT_MS);
  // 外部からのキャンセルも合成
  const combinedSignal = combineAbortSignals(signal, timeoutSignal);

  const pollResult = await pollDeviceToken(
    `${ISSUER}/api/accounts/deviceauth/token`,
    {
      device_auth_id: device.deviceCode,
      user_code: device.userCode,
    },
    {},
    device.intervalSeconds ?? 5,
    combinedSignal,
  );

  if (!pollResult.ok) {
    if (pollResult.error === "denied") {
      throw new Error("認証が拒否されました。");
    }
    if (pollResult.error === "expired") {
      throw new Error("認証コードの有効期限が切れました。もう一度お試しください。");
    }
    if (pollResult.error === "network") {
      throw new Error(
        `ネットワークエラーが発生しました: ${pollResult.message ?? "不明なエラー"}`,
      );
    }
    if (combinedSignal.aborted && signal.aborted) {
      throw new Error("ログインがキャンセルされました。");
    }
    throw new Error("デバイス認証に失敗しました。");
  }

  const authData = pollResult.data as {
    authorization_code: string;
    code_verifier: string;
  };

  // 4. authorization_code → トークン交換
  const tokenResponse = await tauriFetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: authData.authorization_code,
      redirect_uri: `${ISSUER}/deviceauth/callback`,
      client_id: CLIENT_ID,
      code_verifier: authData.code_verifier,
    }).toString(),
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    throw new Error(
      `トークン交換に失敗しました (${tokenResponse.status}): ${text.slice(0, 200)}`,
    );
  }

  const tokens: TokenResponse = await tokenResponse.json();
  const accountId = extractAccountIdFromTokens(tokens);

  const credential: CodexCredential = {
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId,
  };

  await saveCodexCredential(credential);
  return credential;
}

// ---- トークンリフレッシュ（サンプル準拠） ----

let refreshPromise: Promise<CodexCredential> | null = null;

/**
 * リフレッシュトークンを使ってアクセストークンを更新する。
 * 同時に複数のリクエストが来ても1回だけリフレッシュする（deduplicate）。
 */
export async function refreshCodexToken(
  refreshToken: string,
): Promise<CodexCredential> {
  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    try {
      const res = await tauriFetch(`${ISSUER}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: CLIENT_ID,
        }).toString(),
      });

      if (!res.ok) {
        // リフレッシュ失敗 → 再ログインが必要
        await deleteCodexCredential();
        throw new Error(
          "トークンの更新に失敗しました。再ログインしてください。",
        );
      }

      const tokens: TokenResponse = await res.json();
      const previous = await readCodexCredential();
      const accountId =
        extractAccountIdFromTokens(tokens) ?? previous?.accountId;

      const credential: CodexCredential = {
        access: tokens.access_token,
        refresh: tokens.refresh_token,
        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
        accountId,
      };

      await saveCodexCredential(credential);
      return credential;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

// ---- Codex API fetch ラッパー ----

/**
 * Codex API 用の fetch ラッパーを作成する。
 * Bearer 認証・ChatGPT-Account-Id ヘッダーを付与し、期限切れ時は自動リフレッシュする。
 */
export function createCodexFetch(): typeof tauriFetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const credential = await readCodexCredential();
    if (!credential) {
      // 未認証 → API 呼び出し不可能
      throw new Error("Codex にログインしていません。設定画面からログインしてください。");
    }

    let token = credential.access;
    let accountId = credential.accountId;

    // 期限切れチェック（expiry skew: 30秒前からリフレッシュ）
    if (credential.expires < Date.now() + 30_000) {
      try {
        const refreshed = await refreshCodexToken(credential.refresh);
        token = refreshed.access;
        accountId = refreshed.accountId;
      } catch {
        throw new Error("Codex のトークン更新に失敗しました。再ログインしてください。");
      }
    }

    // ヘッダーを構築（既存の Authorization は除去）
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    headers.delete("Authorization");
    headers.set("authorization", `Bearer ${token}`);
    if (accountId) {
      headers.set("ChatGPT-Account-Id", accountId);
    }

    return tauriFetch(input, { ...init, headers });
  };
}

// ---- モデルフィルタリング ----

/** Codex で許可されたモデルのみを返す。サンプルの models() 準拠。 */
export function filterCodexModels(
  models: Record<string, { api?: { id: string } }>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(models).filter(([, model]) => {
      const apiId = model.api?.id ?? "";
      if (ALLOWED_MODELS.has(apiId)) return true;
      if (DISALLOWED_MODELS.has(apiId)) return false;
      // gpt-5.x で 5.4 より大きいバージョンは許可
      const match = apiId.match(/^gpt-(\d+\.\d+)/);
      return match ? parseFloat(match[1]) > 5.4 : false;
    }),
  );
}

// ---- util ----

function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
  // シンプルな合成: いずれかが abort されたら全体を abort
  const controller = new AbortController();
  for (const sig of signals) {
    if (sig.aborted) {
      controller.abort(sig.reason);
      return controller.signal;
    }
    sig.addEventListener("abort", () => controller.abort(sig.reason), { once: true });
  }
  return controller.signal;
}
