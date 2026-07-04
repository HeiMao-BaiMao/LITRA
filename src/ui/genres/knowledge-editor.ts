import DOMPurify from "dompurify";
import type {
  GenreKnowledgeCandidate,
  GenreKnowledgeCategory,
  GenreKnowledgeItem,
} from "../../genres/schema.ts";

const CATEGORY_LABELS: Record<GenreKnowledgeCategory, string> = {
  definition: "定義",
  core_requirement: "中核条件",
  frequent_feature: "頻出特徴",
  optional_feature: "任意特徴",
  boundary_condition: "境界条件",
  genre_differentiator: "ジャンル差異",
  prose_style: "文体",
  narrative_structure: "構成",
  scene_pattern: "場面パターン",
  character_function: "キャラクター機能",
  worldbuilding_function: "世界設定機能",
  reader_contract: "読者との約束",
  emotional_effect: "感情効果",
  generation_guidance: "生成指針",
  prohibition: "禁止・注意",
  failure_mode: "失敗例",
  evaluation_criterion: "評価基準",
};

export interface KnowledgeEditorActions {
  onAcceptCandidate: (candidateId: string) => void;
  onRejectCandidate: (candidateId: string) => void;
  onHoldCandidate: (candidateId: string) => void;
  onCreateItem: () => void;
  onEditItem: (itemId: string) => void;
  onDisableItem: (itemId: string) => void;
  onEnableItem: (itemId: string) => void;
  onDeleteItem: (itemId: string) => void;
}

export function renderKnowledgeEditor(
  container: HTMLElement,
  items: GenreKnowledgeItem[],
  candidates: GenreKnowledgeCandidate[],
  actions: KnowledgeEditorActions,
): void {
  container.innerHTML = "";

  const header = document.createElement("div");
  header.className = "knowledge-header";

  const btnCreate = document.createElement("button");
  btnCreate.type = "button";
  btnCreate.textContent = "＋ 手動で知識を追加";
  btnCreate.addEventListener("click", actions.onCreateItem);
  header.appendChild(btnCreate);

  container.appendChild(header);

  const candidatesSection = document.createElement("div");
  candidatesSection.className = "knowledge-section";
  const candidatesTitle = document.createElement("h4");
  candidatesTitle.textContent = "未確認候補";
  candidatesSection.appendChild(candidatesTitle);

  for (const candidate of candidates.filter((c) => c.status === "pending")) {
    const el = document.createElement("div");
    el.className = "knowledge-candidate";
    el.innerHTML = DOMPurify.sanitize(`
      <div class="knowledge-candidate-header">
        <span class="knowledge-category">${CATEGORY_LABELS[candidate.category]}</span>
        <span class="knowledge-title">${candidate.title}</span>
        <span class="knowledge-importance">${candidate.proposedImportance}</span>
      </div>
      <p class="knowledge-statement">${candidate.statement}</p>
      <p class="knowledge-explanation">${candidate.explanation}</p>
      <p class="knowledge-confidence">確信度: ${Math.round(candidate.confidence * 100)}%</p>
    `);

    const actionsEl = document.createElement("div");
    actionsEl.className = "knowledge-actions";

    const btnAccept = document.createElement("button");
    btnAccept.type = "button";
    btnAccept.textContent = "採用";
    btnAccept.addEventListener("click", () => actions.onAcceptCandidate(candidate.id));

    const btnHold = document.createElement("button");
    btnHold.type = "button";
    btnHold.textContent = "保留";
    btnHold.addEventListener("click", () => actions.onHoldCandidate(candidate.id));

    const btnReject = document.createElement("button");
    btnReject.type = "button";
    btnReject.textContent = "却下";
    btnReject.addEventListener("click", () => actions.onRejectCandidate(candidate.id));

    actionsEl.appendChild(btnAccept);
    actionsEl.appendChild(btnHold);
    actionsEl.appendChild(btnReject);
    el.appendChild(actionsEl);

    candidatesSection.appendChild(el);
  }

  container.appendChild(candidatesSection);

  const itemsSection = document.createElement("div");
  itemsSection.className = "knowledge-section";
  const itemsTitle = document.createElement("h4");
  itemsTitle.textContent = "採用済み知識";
  itemsSection.appendChild(itemsTitle);

  for (const item of items) {
    const el = document.createElement("div");
    el.className = `knowledge-item ${item.status === "disabled" ? "disabled" : ""}`;
    el.innerHTML = DOMPurify.sanitize(`
      <div class="knowledge-item-header">
        <span class="knowledge-category">${CATEGORY_LABELS[item.category]}</span>
        <span class="knowledge-title">${item.title}</span>
        <span class="knowledge-importance">${item.importance}</span>
        <span class="knowledge-status">${item.status}</span>
      </div>
      <p class="knowledge-statement">${item.statement}</p>
      <p class="knowledge-explanation">${item.explanation}</p>
    `);

    const actionsEl = document.createElement("div");
    actionsEl.className = "knowledge-actions";

    const btnEdit = document.createElement("button");
    btnEdit.type = "button";
    btnEdit.textContent = "編集";
    btnEdit.addEventListener("click", () => actions.onEditItem(item.id));

    if (item.status === "active") {
      const btnDisable = document.createElement("button");
      btnDisable.type = "button";
      btnDisable.textContent = "無効化";
      btnDisable.addEventListener("click", () => actions.onDisableItem(item.id));
      actionsEl.appendChild(btnDisable);
    } else {
      const btnEnable = document.createElement("button");
      btnEnable.type = "button";
      btnEnable.textContent = "再有効化";
      btnEnable.addEventListener("click", () => actions.onEnableItem(item.id));
      actionsEl.appendChild(btnEnable);
    }

    const btnDelete = document.createElement("button");
    btnDelete.type = "button";
    btnDelete.textContent = "削除";
    btnDelete.addEventListener("click", () => {
      if (window.confirm(`「${item.title}」を削除しますか？`)) {
        actions.onDeleteItem(item.id);
      }
    });

    actionsEl.appendChild(btnEdit);
    actionsEl.appendChild(btnDelete);
    el.appendChild(actionsEl);

    itemsSection.appendChild(el);
  }

  container.appendChild(itemsSection);
}
