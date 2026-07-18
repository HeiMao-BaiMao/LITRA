pub fn scene_state(context: &str) -> String {
    format!(
        "次の小説本文末尾から、継続執筆に必要な現在状態を日本語で簡潔に整理してください。時刻・場所・登場人物・感情・所持品・未解決の行動だけを根拠に基づいて列挙し、本文にない事実を加えないでください。\n\n{context}"
    )
}

pub fn character_voices(context: &str) -> String {
    format!(
        "次の本文に登場する人物ごとに、継続執筆で維持すべき口調、語彙、呼称、発話の長さ、避ける表現を日本語で整理してください。本文から確認できない人物像は作らないでください。\n\n{context}"
    )
}

pub fn plan(context: &str, beat_split: bool, scene: &str, voices: &str) -> String {
    let format = if beat_split {
        "3〜6個の番号付きビートに分けること。"
    } else {
        "短い箇条書きで示すこと。"
    };
    format!(
        "次の本文の直後に置く場面の執筆計画を作ってください。既存の視点・時制・因果関係を守り、本文にない設定を確定しないでください。{format}\n\n現在状態:\n{scene}\n\n人物の声:\n{voices}\n\n本文末尾:\n{context}"
    )
}

pub fn draft(context: &str, plan: &str, scene: &str, voices: &str) -> String {
    format!(
        "以下の本文の続きを執筆してください。説明、見出し、計画、注釈を出力せず、小説本文だけを返してください。文体・視点・時制・改行密度・固有名詞・呼称を維持し、既出事実と矛盾させないでください。\n\n執筆計画:\n{plan}\n\n現在状態:\n{scene}\n\n人物の声:\n{voices}\n\n既存本文末尾:\n{context}"
    )
}

pub fn select(first: &str, second: &str) -> String {
    format!(
        "二つの続き候補を比較し、既存本文との文体連続性、視点・時制、因果関係、人物の声、冗長さの観点で優れた方を選んでください。返答は 1 または 2 の一文字だけにしてください。\n\n候補1:\n{first}\n\n候補2:\n{second}"
    )
}

pub fn review(context: &str, draft: &str) -> String {
    format!(
        "次の続き候補を厳密にレビューしてください。既存本文に対する矛盾、視点逸脱、時制不整合、人物口調の崩れ、不自然な反復、説明過多を指摘し、修正指示を日本語で返してください。問題がなければ『重大な問題なし』と明記してください。\n\n既存本文末尾:\n{context}\n\n続き候補:\n{draft}"
    )
}

pub fn revise(context: &str, draft: &str, review: &str, targeted: bool) -> String {
    let scope = if targeted {
        "レビューで指摘された箇所だけを必要最小限に修正し、それ以外は維持"
    } else {
        "レビューを反映して全体を推敲"
    };
    format!(
        "続き候補を修正してください。{scope}してください。説明や注釈を付けず、修正後の小説本文だけを返してください。\n\n既存本文末尾:\n{context}\n\nレビュー:\n{review}\n\n修正前候補:\n{draft}"
    )
}

pub fn regression(context: &str, original: &str, revised: &str) -> String {
    format!(
        "修正前と修正後を比較し、修正によって新しい矛盾、欠落、文体悪化が生じていない方を選んでください。返答は修正前なら 1、修正後なら 2 の一文字だけにしてください。\n\n既存本文末尾:\n{context}\n\n修正前:\n{original}\n\n修正後:\n{revised}"
    )
}
