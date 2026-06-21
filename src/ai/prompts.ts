export const systemPrompt = `あなたは日本語の創作小説を支援する有能なアシスタントです。
以下の指針に従ってください。
- ユーザーの意図を尊重し、無理な方向性を押し付けない。
- 日本語の創作小説に適した文体、語り口、登場人物の感情を大切にする。
- 簡潔かつ具体的な提案を行い、創作の手助けになることを目指す。
- 出力はそのまま小説の本文として使えるように、余計な前置きや注釈を避ける。`;

export function buildContinuationPrompt(context: string): string {
  return `以下の小説の続きを、文脈に合わせて自然に書いてください。既存の文体やトーンを維持し、余計な前置きは不要です。\n\n${context}`;
}

export function buildRewritePrompt(selection: string, context: string): string {
  return `以下の選択された文章を、創作小説の文脈に合わせて書き直してください。文体やトーンは周囲の文章と調和させ、余計な前置きは不要です。\n\n【周囲の文脈】\n${context}\n\n【書き直す文章】\n${selection}`;
}

export function buildFeedbackPrompt(selection: string): string {
  return `以下の小説の文章に対して、日本語創作の観点からフィードバックを簡潔に行ってください。良い点、改善点、提案を含めてください。\n\n${selection}`;
}
