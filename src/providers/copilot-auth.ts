/**
 * GitHub Copilot プロバイダーの OAuth デバイスフロー・トークン管理・API fetch ラッパー。
 * サンプル実装 sample/opencode/…/copilot.ts を正確にトレースする。
 */

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

export const GITHUB_COPILOT_CLIENT_ID = "Ov23li8tweQw6odWQebz";
export const API_VERSION = "2026-06-01";
export const DEFAULT_COPILOT_BASE = "https://api.githubcopilot.com";

const OAUTH_POLLING_TIMEOUT_MS = 5 * 60 * 1_000;

// ---- 型 ----

export interface CopilotCredential {
  [key: string]: unknown;
  /** GitHub アクセストークン（refresh と access は同一トークン） */
  token: string;
  enterpriseUrl?: string;
}

// ---- キーリング I/O ----

const CREDENTIAL_PROVIDER = "github-copilot" as const;

export async function readCopilotCredential(): Promise<CopilotCredential | undefined> {
  return readOAuthCredential<CopilotCredential>(CREDENTIAL_PROVIDER);
}

async function saveCopilotCredential(cred: CopilotCredential): Promise<void> {
  await writeOAuthCredential(CREDENTIAL_PROVIDER, cred);
  // ログイン時にモデルキャッシュを無効化（再取得させる）
  invalidateCopilotModelCache();
}

export async function deleteCopilotCredential(): Promise<void> {
  await writeOAuthCredential(CREDENTIAL_PROVIDER, undefined);
  // ログアウト時にモデルキャッシュを無効化
  invalidateCopilotModelCache();
}

// ---- ベースURL解決 ----

export function getCopilotBaseUrl(enterpriseUrl?: string): string {
  if (enterpriseUrl) {
    const domain = enterpriseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
    return `https://copilot-api.${domain}`;
  }
  return DEFAULT_COPILOT_BASE;
}

// ---- デバイス OAuth（サンプル準拠） ----

export async function loginWithDeviceCode(
  signal: AbortSignal,
  enterpriseUrl?: string,
  onUserCode?: (code: string, verificationUri: string) => void,
): Promise<CopilotCredential> {
  const domain = enterpriseUrl
    ? enterpriseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")
    : "github.com";
  const deviceCodeUrl = `https://${domain}/login/device/code`;
  const accessTokenUrl = `https://${domain}/login/oauth/access_token`;

  // 1. デバイスコード発行
  const oauthHeaders = { "User-Agent": "litra/1.0" };
  const device = await startDeviceAuth(
    deviceCodeUrl,
    {
      client_id: GITHUB_COPILOT_CLIENT_ID,
      scope: "read:user",
    },
    oauthHeaders,
  );

  // 2. verification_uri をブラウザで開く（GitHub の verification_uri は github.com/login/device）
  const verificationUrl = device.verificationUri || `https://${domain}/login/device`;
  await openUrl(verificationUrl).catch(() => {
    // エラー時はコード表示で対応
  });

  // ユーザーコードを表示するコールバック
  onUserCode?.(device.userCode, verificationUrl);

  // 3. ポーリングでアクセストークンを取得
  const timeoutSignal = AbortSignal.timeout(OAUTH_POLLING_TIMEOUT_MS);
  const combinedSignal = combineAbortSignals(signal, timeoutSignal);

  const pollResult = await pollDeviceToken(
    accessTokenUrl,
    {
      client_id: GITHUB_COPILOT_CLIENT_ID,
      device_code: device.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    },
    oauthHeaders,
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
    throw new Error("GitHub Copilot の認証に失敗しました。");
  }

  const tokenData = pollResult.data as { access_token?: string };
  if (!tokenData.access_token) {
    throw new Error("アクセストークンが取得できませんでした。");
  }

  const credential: CopilotCredential = {
    token: tokenData.access_token,
    ...(enterpriseUrl ? { enterpriseUrl } : {}),
  };

  await saveCopilotCredential(credential);
  return credential;
}

// ---- Copilot API fetch ラッパー（サンプル準拠） ----

/**
 * GitHub Copilot API 用の fetch ラッパーを作成する。
 * GitHub トークンを Bearer 認証に使い、必要なヘッダー（API-Version, User-Agent, Openai-Intent）を付与する。
 */
export function createCopilotFetch(): typeof tauriFetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const credential = await readCopilotCredential();
    if (!credential) {
      throw new Error(
        "GitHub Copilot にログインしていません。設定画面からログインしてください。",
      );
    }

    // リクエストボディを解析して agent か user か判定（サンプルの x-initiator ロジック準拠）
    let isAgent = false;
    let isVision = false;
    try {
      const bodyStr =
        typeof init?.body === "string"
          ? init.body
          : init?.body instanceof URLSearchParams
            ? init.body.toString()
            : null;
      if (bodyStr) {
        const body = JSON.parse(bodyStr);
        const messages = body?.messages ?? body?.input ?? [];
        if (Array.isArray(messages) && messages.length > 0) {
          const last = messages[messages.length - 1];
          isAgent = last?.role !== "user";
          isVision = messages.some((msg: Record<string, unknown>) => {
            const content = msg.content;
            return Array.isArray(content) && content.some(
              (part: Record<string, unknown>) =>
                part?.type === "image_url" || part?.type === "input_image" || part?.type === "image",
            );
          });
        }
      }
    } catch {
      // 解析不能な body は user-initiated として扱う
    }

    // ヘッダー構築（サンプル準拠）
    const headers = new Headers(init?.headers);
    headers.delete("authorization");
    headers.delete("Authorization");
    headers.delete("x-api-key");
    headers.set("Authorization", `Bearer ${credential.token}`);
    headers.set("User-Agent", "litra/1.0");
    headers.set("X-GitHub-Api-Version", API_VERSION);
    headers.set("Openai-Intent", "conversation-edits");
    headers.set("x-initiator", isAgent ? "agent" : "user");

    if (isVision) {
      headers.set("Copilot-Vision-Request", "true");
    }

    return tauriFetch(input, { ...init, headers });
  };
}

// ---- モデル一覧取得（サンプル models.ts 準拠） ----

interface RawModelItem {
  model_picker_enabled?: boolean;
  id: string;
  name: string;
  version: string;
  supported_endpoints?: string[];
  policy?: { state?: string };
  billing?: {
    token_prices?: {
      batch_size: number;
      default: { cache_price: number; input_price: number; output_price: number };
    };
  };
  capabilities: {
    family: string;
    limits?: {
      max_context_window_tokens?: number;
      max_output_tokens?: number;
      max_prompt_tokens?: number;
      vision?: {
        max_prompt_image_size: number;
        max_prompt_images: number;
        supported_media_types: string[];
      };
    };
    supports: {
      adaptive_thinking?: boolean;
      max_thinking_budget?: number;
      min_thinking_budget?: number;
      reasoning_effort?: string[];
      streaming?: boolean;
      structured_outputs?: boolean;
      tool_calls?: boolean;
      vision?: boolean;
    };
  };
}

/**
 * Copilot モデルの拡張キャッシュエントリ。
 * エンドポイントに加えて、reasoning 関連の能力情報も保持する。
 */
export interface CopilotModelCacheEntry {
  id: string;
  endpoint: "chat" | "responses" | "messages";
  /** サーバーから返された reasoning_effort 対応値一覧（あれば） */
  reasoningEffort?: string[];
  /** adaptive_thinking 対応かどうか */
  adaptiveThinking?: boolean;
  /** 最小 thinking budget */
  minThinkingBudget?: number;
  /** 最大 thinking budget */
  maxThinkingBudget?: number;
}

/**
 * Copilot の `/models` エンドポイントからモデル一覧を取得する。
 * 結果はキャッシュされる（同一セッション内）。
 * キャッシュはログイン/ログアウトで無効化される。
 */
let cachedModels: Record<string, CopilotModelCacheEntry> | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 600_000; // 10分

/** ログイン/ログアウト時にキャッシュを無効化する */
export function invalidateCopilotModelCache(): void {
  cachedModels = null;
  cachedAt = 0;
}

/** Rust のモデル一覧 command が返した capability を同期キャッシュへ反映する。 */
export function cacheCopilotModels(models: Record<string, CopilotModelCacheEntry>): void {
  cachedModels = models;
  cachedAt = Date.now();
}

/**
 * 同期モデルルックアップ。キャッシュが存在すればそこから model の情報を返す。
 * キャッシュが無い場合やモデルが見つからない場合は undefined。
 */
export function getCopilotModelCacheEntry(modelId: string): CopilotModelCacheEntry | undefined {
  return cachedModels?.[modelId];
}

export async function fetchCopilotModels(): Promise<
  Record<string, CopilotModelCacheEntry>
> {
  if (cachedModels && Date.now() - cachedAt < CACHE_TTL_MS) {
    return cachedModels;
  }

  const credential = await readCopilotCredential();
  if (!credential) {
    return {};
  }

  const baseUrl = getCopilotBaseUrl(credential.enterpriseUrl);

  try {
    const res = await tauriFetch(`${baseUrl}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${credential.token}`,
        "User-Agent": "litra/1.0",
        "X-GitHub-Api-Version": API_VERSION,
      },
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      console.warn("[litra] Failed to fetch Copilot models:", res.status);
      return {};
    }

    const data = (await res.json()) as { data?: unknown[] };
    const entries = data.data ?? [];

    const models: Record<string, CopilotModelCacheEntry> = {};
    for (const raw of entries) {
      const item = raw as RawModelItem;
      if (typeof item.id !== "string") continue;
      if (item.policy?.state === "disabled" || item.model_picker_enabled !== true) continue;
      if (
        item.capabilities?.limits?.max_output_tokens === undefined ||
        item.capabilities.limits.max_prompt_tokens === undefined ||
        item.capabilities.supports.tool_calls === undefined
      ) continue;

      let endpoint: "chat" | "responses" | "messages" = "chat";
      if (item.supported_endpoints?.includes("/v1/messages")) {
        endpoint = "messages";
      } else if (item.supported_endpoints?.includes("/responses")) {
        endpoint = "responses";
      } else if (item.supported_endpoints?.includes("/chat/completions")) {
        endpoint = "chat";
      }

      models[item.id] = {
        id: item.id,
        endpoint,
        reasoningEffort: item.capabilities.supports.reasoning_effort,
        adaptiveThinking: item.capabilities.supports.adaptive_thinking,
        minThinkingBudget: item.capabilities.supports.min_thinking_budget,
        maxThinkingBudget: item.capabilities.supports.max_thinking_budget,
      };
    }

    cachedModels = models;
    cachedAt = Date.now();
    return models;
  } catch (err) {
    console.warn("[litra] Copilot models fetch error:", err);
    return {};
  }
}

/**
 * Copilot の model ID から使用すべき endpoint を返す。
 * キャッシュが無ければ "chat" をフォールバックする。
 */
export function getCopilotModelEndpoint(modelId: string): "chat" | "responses" | "messages" {
  const cached = cachedModels?.[modelId]?.endpoint;
  if (cached) return cached;
  // The picker normally populates the cache first. These conservative fallbacks
  // keep configured models usable before the first successful /models request.
  if (modelId.startsWith("claude-")) return "messages";
  if (/^gpt-5(?:[.-]|$)/.test(modelId)) return "responses";
  return "chat";
}

// ---- util ----

function combineAbortSignals(...signals: AbortSignal[]): AbortSignal {
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
