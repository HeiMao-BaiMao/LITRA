import type { Provider } from "../settings.ts";

const OFFICIAL_HOSTS = {
  deepseek: "api.deepseek.com",
  opencode: "opencode.ai",
  sakura: "api.ai.sakura.ad.jp",
} as const;

function hasHost(value: string, host: string): boolean {
  try {
    return new URL(value).hostname === host;
  } catch {
    return value.includes(host);
  }
}

/** 別 Provider の公式 URL が設定に残った場合だけ安全な既定値へ戻す。カスタム proxy は保持する。 */
export function resolveProviderBaseUrl(provider: Provider, configuredBaseUrl: string): string {
  const baseUrl = configuredBaseUrl.trim();
  if (provider === "sakura" && hasHost(baseUrl, OFFICIAL_HOSTS.deepseek)) {
    return `https://${OFFICIAL_HOSTS.sakura}/v1`;
  }
  if (provider === "deepseek" && hasHost(baseUrl, OFFICIAL_HOSTS.opencode)) {
    return `https://${OFFICIAL_HOSTS.deepseek}`;
  }
  if (provider === "opencode" && hasHost(baseUrl, OFFICIAL_HOSTS.deepseek)) {
    return `https://${OFFICIAL_HOSTS.opencode}/zen/go/v1`;
  }
  return baseUrl;
}
