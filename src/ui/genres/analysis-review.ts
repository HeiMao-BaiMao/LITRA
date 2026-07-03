import type {
  GenreAnalysisRun,
  GenreSegmentAnalysis,
  GenreSource,
  GenreSourceSegment,
} from "../../genres/schema.ts";

export interface AnalysisReviewActions {
  onAnalyze: () => void;
  onAcceptCandidate: (candidateId: string) => void;
  onRejectCandidate: (candidateId: string) => void;
}

export function renderAnalysisReview(
  container: HTMLElement,
  source: GenreSource,
  run: GenreAnalysisRun | undefined,
  segments: GenreSourceSegment[],
  actions: AnalysisReviewActions,
): void {
  container.innerHTML = "";
  container.className = "analysis-review";

  const summary = document.createElement("div");
  summary.className = "analysis-summary";

  const title = document.createElement("h3");
  title.textContent = source.title;
  summary.appendChild(title);

  const meta = document.createElement("div");
  meta.className = "analysis-segment-header";
  meta.textContent = [
    source.author ? `作者: ${source.author}` : null,
    `役割: ${source.sourceRole}`,
    `好み: ${source.preference}`,
    `文字数: ${source.characterCount.toLocaleString()}`,
  ]
    .filter((value): value is string => value !== null)
    .join(" · ");
  summary.appendChild(meta);

  const status = document.createElement("div");
  status.className = "analysis-status";
  if (!run) {
    status.textContent = "分析: 未実行";
  } else {
    status.textContent = `分析: ${run.status} · ${run.model} · ${new Date(run.startedAt).toLocaleString()}`;
  }
  summary.appendChild(status);

  const btnAnalyze = document.createElement("button");
  btnAnalyze.type = "button";
  btnAnalyze.textContent = run?.status === "running" ? "分析中..." : "資料を分析";
  btnAnalyze.disabled = run?.status === "running";
  btnAnalyze.addEventListener("click", actions.onAnalyze);
  summary.appendChild(btnAnalyze);

  container.appendChild(summary);

  if (!run) {
    return;
  }

  const runContainer = document.createElement("div");
  renderAnalysisList(runContainer, [run]);
  container.appendChild(runContainer);

  if (run.segmentResults.length === 0) {
    return;
  }

  const segmentSection = document.createElement("div");
  segmentSection.className = "analysis-segment-list";

  const sectionTitle = document.createElement("h4");
  sectionTitle.textContent = "セグメント分析";
  segmentSection.appendChild(sectionTitle);

  for (const segmentAnalysis of run.segmentResults) {
    const segment = segments.find((s) => s.id === segmentAnalysis.segmentId);
    const wrapper = document.createElement("div");
    wrapper.className = "analysis-segment";

    const header = document.createElement("div");
    header.className = "analysis-segment-header";
    header.textContent = segment?.heading
      ? `${segment.ordinal + 1}. ${segment.heading}`
      : `セグメント ${segmentAnalysis.segmentId}`;
    wrapper.appendChild(header);

    const segmentContainer = document.createElement("div");
    renderSegmentAnalysis(segmentContainer, segmentAnalysis);
    wrapper.appendChild(segmentContainer);

    segmentSection.appendChild(wrapper);
  }

  container.appendChild(segmentSection);
}

export function renderAnalysisList(
  container: HTMLElement,
  runs: GenreAnalysisRun[],
): void {
  container.innerHTML = "";

  for (const run of runs.sort(
    (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
  )) {
    const el = document.createElement("div");
    el.className = "analysis-run-item";

    const header = document.createElement("div");
    header.className = "analysis-run-header";
    header.textContent = `${new Date(run.startedAt).toLocaleString()} · ${run.model} · ${run.status}`;

    const meta = document.createElement("div");
    meta.className = "analysis-run-meta";
    meta.textContent = `セグメント: ${run.completedSegments}/${run.totalSegments}（失敗 ${run.failedSegments}）`;

    el.appendChild(header);
    el.appendChild(meta);

    if (run.synthesis) {
      const synthesis = document.createElement("div");
      synthesis.className = "analysis-run-synthesis";
      synthesis.innerHTML = `
        <p><strong>資料要約:</strong> ${run.synthesis.sourceSummary}</p>
        <p><strong>ジャンルへの貢献:</strong> ${run.synthesis.contributionToGenre.join("、 ")}</p>
        <p><strong>逸脱:</strong> ${run.synthesis.deviationsFromGenre.join("、 ")}</p>
        <p><strong>作品固有要素:</strong> ${run.synthesis.workSpecificElements.join("、 ")}</p>
      `;
      el.appendChild(synthesis);
    }

    if (run.error) {
      const error = document.createElement("div");
      error.className = "analysis-run-error";
      error.textContent = `エラー: ${run.error}`;
      el.appendChild(error);
    }

    container.appendChild(el);
  }
}

export function renderSegmentAnalysis(
  container: HTMLElement,
  analysis: GenreSegmentAnalysis,
): void {
  container.innerHTML = "";

  const summary = document.createElement("div");
  summary.className = "segment-analysis-summary";
  summary.innerHTML = `<h4>セグメント要約</h4><p>${analysis.summary}</p>`;
  container.appendChild(summary);

  const sections: Array<{ title: string; items: GenreSegmentAnalysis["proseFeatures"] }> = [
    { title: "散文", items: analysis.proseFeatures },
    { title: "リズム", items: analysis.rhythmFeatures },
    { title: "会話", items: analysis.dialogueFeatures },
    { title: "描写", items: analysis.descriptionFeatures },
    { title: "心理描写", items: analysis.interiorityFeatures },
    { title: "テンポ", items: analysis.pacingFeatures },
    { title: "情報開示", items: analysis.informationDisclosureFeatures },
    { title: "感情効果", items: analysis.emotionalEffectFeatures },
    { title: "物語機能", items: analysis.narrativeFunctions },
    { title: "キャラクター機能", items: analysis.characterFunctions },
    { title: "世界設定機能", items: analysis.worldbuildingFunctions },
    { title: "ジャンル信号", items: analysis.genreSignals },
    { title: "非ジャンル信号", items: analysis.nonGenreSignals },
    { title: "作品固有特徴", items: analysis.workSpecificFeatures },
    { title: "失敗モード", items: analysis.possibleFailureModes },
    { title: "生成指針", items: analysis.generationGuidance },
  ];

  for (const section of sections) {
    if (section.items.length === 0) continue;
    const sectionEl = document.createElement("div");
    sectionEl.className = "segment-analysis-section";
    const title = document.createElement("h5");
    title.textContent = section.title;
    sectionEl.appendChild(title);

    for (const item of section.items) {
      const itemEl = document.createElement("div");
      itemEl.className = "feature-observation";
      itemEl.innerHTML = `
        <p class="feature-statement">${item.statement}</p>
        <p class="feature-explanation">${item.explanation}</p>
        <p class="feature-confidence">確信度: ${Math.round(item.confidence * 100)}%</p>
      `;
      sectionEl.appendChild(itemEl);
    }

    container.appendChild(sectionEl);
  }
}
