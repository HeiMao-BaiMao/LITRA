/**
 * 設定マージ用の純粋ヘルパー。
 *
 * ??(nullish coalescing)では undefined と「キーがオブジェクトに存在しない」を
 * 区別できない。設定モーダルが明示的に undefined を返した（＝「チャット欄に同期」
 * などユーザーが空欄を選んだ）ケースを正しく反映するため、in 演算子で判定する。
 */

/**
 * `source` に `key` が自身のプロパティとして存在すればその値（undefined でも可）
 * を返す。存在しなければ `fallback[key]` を返す。
 *
 * @example
 * ```ts
 * pickDefinedOrFallback({ x: undefined }, { x: 1 }, "x") // → undefined
 * pickDefinedOrFallback({},             { x: 1 }, "x") // → 1
 * pickDefinedOrFallback({ x: 42 },      { x: 1 }, "x") // → 42
 * ```
 */
export function pickDefinedOrFallback<T, K extends keyof T>(
  source: Partial<T>,
  fallback: T,
  key: K,
): T[K] {
  return key in source ? (source as T)[key] : fallback[key];
}
