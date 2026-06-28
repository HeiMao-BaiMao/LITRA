/**
 * テキストの SHA-256 ハッシュ値を計算する。
 * ブラウザ環境で安定して利用できる Web Crypto API を使用する。
 */
export async function computeTextHash(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const buffer = await crypto.subtle.digest("SHA-256", data);
  const array = new Uint8Array(buffer);
  return Array.from(array)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * バイナリデータを Base64URL 風の短い識別子へ変換する。
 * ハッシュ値の先頭 16 文字を返す用途で使用可能。
 */
export function shortenHash(hash: string, length = 16): string {
  return hash.slice(0, length);
}
