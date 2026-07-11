/**
 * OAuth デバイスフローの共通ユーティリティ。
 * プロバイダー固有の知識を持たず、HTTP 呼び出しとポーリングの汎用パーツだけを提供する。
 * 呼び出し側（codex-auth.ts / copilot-auth.ts）がエンドポイント・Client ID・ヘッダーを指定する。
 */

import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

/** ポーリングのセーフティマージン（ms）。サーバーが指定した間隔より少し長く待つ */
export const OAUTH_POLLING_SAFETY_MARGIN_MS = 3_000;

/** デバイス認証のタイムアウト（ms） */
export const OAUTH_DEVICE_TIMEOUT_MS = 5 * 60 * 1_000;

/** デバイスコード発行の応答型 */
export interface DeviceCodeResponse {
  /** 認証を一意に識別する ID（Codex は device_auth_id、Copilot は device_code） */
  deviceCode: string;
  /** ユーザーが入力するコード */
  userCode: string;
  /** 確認用 URL */
  verificationUri: string;
  /** ポーリング間隔（秒）。サーバー指定が無ければ undefined */
  intervalSeconds?: number;
}

/** トークン要求の結果型 */
export type DeviceTokenResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: "authorization_pending" | "slow_down" | "denied" | "expired" | "unknown" }
  | { ok: false; error: "network"; message: string };

/**
 * デバイスコードを発行する。
 * @param url デバイスコード発行エンドポイント
 * @param body POST する JSON ボディ
 * @param headers 追加 HTTP ヘッダー
 */
export async function startDeviceAuth(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<DeviceCodeResponse> {
  const res = await tauriFetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `デバイス認証の開始に失敗しました (${res.status}): ${text.slice(0, 200)}`,
    );
  }

  const data = (await res.json()) as Record<string, unknown>;

  // Codex 形式: { device_auth_id, user_code, interval }
  // Copilot 形式: { device_code, user_code, verification_uri, interval }
  const deviceCode =
    String(data.device_code ?? data.device_auth_id ?? "");
  const userCode = String(data.user_code ?? "");
  const verificationUri = data.verification_uri
    ? String(data.verification_uri)
    : typeof data.verification_url === "string"
      ? data.verification_url
      : "";
  const intervalSeconds =
    typeof data.interval === "number"
      ? data.interval
      : typeof data.interval === "string"
        ? parseInt(data.interval, 10) || 5
        : 5;

  if (!deviceCode || !userCode) {
    throw new Error("デバイス認証の応答に必要なフィールドが不足しています。");
  }

  return { deviceCode, userCode, verificationUri, intervalSeconds };
}

/**
 * デバイス認証のトークンをポーリングする。
 * @param url トークン取得エンドポイント
 * @param body POST する JSON ボディ
 * @param headers 追加 HTTP ヘッダー
 * @param intervalSeconds ポーリング間隔（秒）
 * @param signal 中断シグナル
 */
export async function pollDeviceToken(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  intervalSeconds: number,
  signal: AbortSignal,
): Promise<DeviceTokenResult> {
  let currentInterval = intervalSeconds;

  while (!signal.aborted) {
    // デッドラインは呼び出し側で AbortSignal.timeout として指定されている前提
    try {
      const res = await tauriFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      });

      // GitHub はポーリング中の authorization_pending / slow_down を HTTP 200 の
      // JSON として返す。Codex は同じ状態を 403/404 で返すため、status と本文の
      // 両方を見てから成功判定する。
      const responseBody = await res.text().catch(() => "");
      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = JSON.parse(responseBody) as Record<string, unknown>;
      } catch {
        parsed = undefined;
      }

      let errorCode = String(parsed?.error ?? parsed?.errorCode ?? "unknown");
      if ((res.status === 403 || res.status === 404) && errorCode === "unknown") {
        errorCode = "authorization_pending";
      }

      if (res.ok && errorCode === "unknown") {
        return { ok: true, data: parsed ?? {} };
      }

      if (!res.ok && !parsed && errorCode === "unknown") {
        return { ok: false, error: "network", message: responseBody.slice(0, 200) };
      }

      if (errorCode === "authorization_pending") {
        await sleep(currentInterval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS, signal);
        continue;
      }

      if (errorCode === "slow_down") {
        // RFC 8628: slow_down のときは interval に 5 秒加算
        currentInterval = Math.min(currentInterval + 5, 30);
        await sleep(currentInterval * 1000 + OAUTH_POLLING_SAFETY_MARGIN_MS, signal);
        continue;
      }

      if (errorCode === "access_denied" || errorCode === "denied") {
        return { ok: false, error: "denied" };
      }

      if (errorCode === "expired_token" || errorCode === "expired") {
        return { ok: false, error: "expired" };
      }

      return { ok: false, error: "unknown" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (signal.aborted) {
        return { ok: false, error: "unknown" };
      }
      // ネットワークエラーはリトライではなく、呼び出し側に任せる
      return { ok: false, error: "network", message };
    }
  }

  return { ok: false, error: "unknown" };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      if (!signal.aborted) resolve();
      else resolve();
    }, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
