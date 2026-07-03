export interface AppElements {
  editor: HTMLTextAreaElement;
  chatForm: HTMLFormElement;
  chatInput: HTMLTextAreaElement;
  chatMessages: HTMLElement;
  btnSend: HTMLButtonElement;
  btnCancel: HTMLButtonElement;
  btnContinue: HTMLButtonElement;
  btnRewrite: HTMLButtonElement;
  btnFeedback: HTMLButtonElement;
  btnSettings: HTMLButtonElement;
  btnGenreLibrary: HTMLButtonElement;
  toolbarProjectName: HTMLElement;
  btnProjects: HTMLButtonElement;
  btnImport: HTMLButtonElement;
  editorSection: HTMLElement;
  projectNav: HTMLElement;
  episodeList: HTMLElement;
  btnNewEpisode: HTMLButtonElement;
  navCharacters: HTMLButtonElement;
  navWorld: HTMLButtonElement;
  navRelationships: HTMLButtonElement;
  navMemos: HTMLButtonElement;
  episodeSummary: HTMLTextAreaElement;
  btnGenerateSummary: HTMLButtonElement;
  summarySection: HTMLElement;
  btnPopoutSummary: HTMLButtonElement;
  memoSection: HTMLElement;
  btnToggleMemo: HTMLButtonElement;
  btnPopoutMemo: HTMLButtonElement;
  episodeMemo: HTMLTextAreaElement;
  chatPanel: HTMLElement;
  chatProviderSelect: HTMLSelectElement;
  chatModelSelect: HTMLSelectElement;
  btnToggleChat: HTMLButtonElement;
  btnPopoutChat: HTMLButtonElement;
  settingsSection: HTMLElement;
  btnPopoutSettings: HTMLButtonElement;
  settingsPanel: HTMLElement;
  memosSection: HTMLElement;
  btnPopoutMemos: HTMLButtonElement;
  memosPanel: HTMLElement;
  settingsModal: HTMLElement;
  settingsForm: HTMLFormElement;
  settingProvider: HTMLSelectElement;
  settingApiKey: HTMLInputElement;
  settingBaseUrl: HTMLInputElement;
  settingModel: HTMLInputElement;
  settingModelSelect: HTMLSelectElement;
  btnFetchModels: HTMLButtonElement;
  settingTemperature: HTMLInputElement;
  settingMaxTokens: HTMLInputElement;
  settingMaxContextTokens: HTMLInputElement;
  advancedSettingsToggle: HTMLButtonElement;
  advancedSettings: HTMLElement;
  settingTopP: HTMLInputElement;
  settingTopK: HTMLInputElement;
  settingFrequencyPenalty: HTMLInputElement;
  settingPresencePenalty: HTMLInputElement;
  settingOpenaiReasoningEffort: HTMLSelectElement;
  settingDeepseekReasoningEffort: HTMLSelectElement;
  settingAnthropicThinkingEnabled: HTMLInputElement;
  settingAnthropicThinkingBudget: HTMLInputElement;
  btnSaveSettings: HTMLButtonElement;
  btnCancelSettings: HTMLButtonElement;
  btnInitializeSettings: HTMLButtonElement;
  projectModal: HTMLElement;
  projectList: HTMLElement;
  projectTitleInput: HTMLInputElement;
  btnCreateProject: HTMLButtonElement;
  btnCloseProjectModal: HTMLButtonElement;
  btnImportFolder: HTMLButtonElement;
  folderImportInput: HTMLInputElement;
  importPreviewModal: HTMLElement;
  importPreviewTitle: HTMLElement;
  importPreviewList: HTMLElement;
  btnConfirmImport: HTMLButtonElement;
  btnCancelImport: HTMLButtonElement;
  radioImportBodyAndSettings: HTMLInputElement;
  radioImportSettingsOnly: HTMLInputElement;
  chkImportDoubleCheck: HTMLInputElement;
}

let elements: AppElements | null = null;

export function getElements(): AppElements {
  if (elements) {
    return elements;
  }

  const editor = document.querySelector<HTMLTextAreaElement>("#editor");
  const chatForm = document.querySelector<HTMLFormElement>("#chat-form");
  const chatInput = document.querySelector<HTMLTextAreaElement>("#chat-input");
  const chatMessages = document.querySelector<HTMLElement>("#chat-messages");
  const btnSend = document.querySelector<HTMLButtonElement>("#btn-send");
  const btnCancel = document.querySelector<HTMLButtonElement>("#btn-cancel");
  const btnContinue = document.querySelector<HTMLButtonElement>("#btn-continue");
  const btnRewrite = document.querySelector<HTMLButtonElement>("#btn-rewrite");
  const btnFeedback = document.querySelector<HTMLButtonElement>("#btn-feedback");
  const btnSettings = document.querySelector<HTMLButtonElement>("#btn-settings");
  const btnGenreLibrary = document.querySelector<HTMLButtonElement>("#btn-genre-library");
  const toolbarProjectName = document.querySelector<HTMLElement>("#toolbar-project-name");
  const btnProjects = document.querySelector<HTMLButtonElement>("#btn-projects");
  const btnImport = document.querySelector<HTMLButtonElement>("#btn-import");
  const editorSection = document.querySelector<HTMLElement>("#editor-section");
  const projectNav = document.querySelector<HTMLElement>("#project-nav");
  const episodeList = document.querySelector<HTMLElement>("#episode-list");
  const btnNewEpisode = document.querySelector<HTMLButtonElement>("#btn-new-episode");
  const navCharacters = document.querySelector<HTMLButtonElement>("#nav-characters");
  const navWorld = document.querySelector<HTMLButtonElement>("#nav-world");
  const navRelationships = document.querySelector<HTMLButtonElement>("#nav-relationships");
  const navMemos = document.querySelector<HTMLButtonElement>("#nav-memos");
  const episodeSummary = document.querySelector<HTMLTextAreaElement>("#episode-summary");
  const btnGenerateSummary = document.querySelector<HTMLButtonElement>("#btn-generate-summary");
  const summarySection = document.querySelector<HTMLElement>("#summary-section");
  const btnPopoutSummary = document.querySelector<HTMLButtonElement>("#btn-popout-summary");
  const memoSection = document.querySelector<HTMLElement>("#memo-section");
  const btnToggleMemo = document.querySelector<HTMLButtonElement>("#btn-toggle-memo");
  const btnPopoutMemo = document.querySelector<HTMLButtonElement>("#btn-popout-memo");
  const episodeMemo = document.querySelector<HTMLTextAreaElement>("#episode-memo");
  const chatPanel = document.querySelector<HTMLElement>("#chat-panel");
  const chatProviderSelect = document.querySelector<HTMLSelectElement>("#chat-provider");
  const chatModelSelect = document.querySelector<HTMLSelectElement>("#chat-model");
  const btnToggleChat = document.querySelector<HTMLButtonElement>("#btn-toggle-chat");
  const btnPopoutChat = document.querySelector<HTMLButtonElement>("#btn-popout-chat");
  const settingsSection = document.querySelector<HTMLElement>("#settings-section");
  const btnPopoutSettings = document.querySelector<HTMLButtonElement>("#btn-popout-settings");
  const settingsPanel = document.querySelector<HTMLElement>("#settings-panel");
  const memosSection = document.querySelector<HTMLElement>("#memos-section");
  const btnPopoutMemos = document.querySelector<HTMLButtonElement>("#btn-popout-memos");
  const memosPanel = document.querySelector<HTMLElement>("#memos-panel");
  const settingsModal = document.querySelector<HTMLElement>("#settings-modal");
  const settingsForm = document.querySelector<HTMLFormElement>("#settings-form");
  const settingProvider = document.querySelector<HTMLSelectElement>("#setting-provider");
  const settingApiKey = document.querySelector<HTMLInputElement>("#setting-api-key");
  const settingBaseUrl = document.querySelector<HTMLInputElement>("#setting-base-url");
  const settingModel = document.querySelector<HTMLInputElement>("#setting-model");
  const settingModelSelect = document.querySelector<HTMLSelectElement>("#setting-model-select");
  const btnFetchModels = document.querySelector<HTMLButtonElement>("#btn-fetch-models");
  const settingTemperature = document.querySelector<HTMLInputElement>("#setting-temperature");
  const settingMaxTokens = document.querySelector<HTMLInputElement>("#setting-max-tokens");
  const settingMaxContextTokens = document.querySelector<HTMLInputElement>("#setting-max-context-tokens");
  const advancedSettingsToggle = document.querySelector<HTMLButtonElement>("#advanced-settings-toggle");
  const advancedSettings = document.querySelector<HTMLElement>("#advanced-settings");
  const settingTopP = document.querySelector<HTMLInputElement>("#setting-top-p");
  const settingTopK = document.querySelector<HTMLInputElement>("#setting-top-k");
  const settingFrequencyPenalty = document.querySelector<HTMLInputElement>("#setting-frequency-penalty");
  const settingPresencePenalty = document.querySelector<HTMLInputElement>("#setting-presence-penalty");
  const settingOpenaiReasoningEffort = document.querySelector<HTMLSelectElement>("#setting-openai-reasoning-effort");
  const settingDeepseekReasoningEffort = document.querySelector<HTMLSelectElement>("#setting-deepseek-reasoning-effort");
  const settingAnthropicThinkingEnabled = document.querySelector<HTMLInputElement>("#setting-anthropic-thinking-enabled");
  const settingAnthropicThinkingBudget = document.querySelector<HTMLInputElement>("#setting-anthropic-thinking-budget");
  const btnSaveSettings = document.querySelector<HTMLButtonElement>("#btn-save-settings");
  const btnCancelSettings = document.querySelector<HTMLButtonElement>("#btn-cancel-settings");
  const btnInitializeSettings = document.querySelector<HTMLButtonElement>("#btn-initialize-settings");
  const projectModal = document.querySelector<HTMLElement>("#project-modal");
  const projectList = document.querySelector<HTMLElement>("#project-list");
  const projectTitleInput = document.querySelector<HTMLInputElement>("#project-title-input");
  const btnCreateProject = document.querySelector<HTMLButtonElement>("#btn-create-project");
  const btnCloseProjectModal = document.querySelector<HTMLButtonElement>("#btn-close-project-modal");
  const btnImportFolder = document.querySelector<HTMLButtonElement>("#btn-import-folder");
  const folderImportInput = document.querySelector<HTMLInputElement>("#folder-import-input");
  const importPreviewModal = document.querySelector<HTMLElement>("#import-preview-modal");
  const importPreviewTitle = document.querySelector<HTMLElement>("#import-preview-title");
  const importPreviewList = document.querySelector<HTMLElement>("#import-preview-list");
  const btnConfirmImport = document.querySelector<HTMLButtonElement>("#btn-confirm-import");
  const btnCancelImport = document.querySelector<HTMLButtonElement>("#btn-cancel-import");
  const radioImportBodyAndSettings = document.querySelector<HTMLInputElement>("#radio-import-body-and-settings");
  const radioImportSettingsOnly = document.querySelector<HTMLInputElement>("#radio-import-settings-only");
  const chkImportDoubleCheck = document.querySelector<HTMLInputElement>("#chk-import-double-check");

  if (
    !editor ||
    !chatForm ||
    !chatInput ||
    !chatMessages ||
    !btnSend ||
    !btnCancel ||
    !btnContinue ||
    !btnRewrite ||
    !btnFeedback ||
    !btnSettings ||
    !btnGenreLibrary ||
    !settingsModal ||
    !settingsForm ||
    !settingProvider ||
    !settingApiKey ||
    !settingBaseUrl ||
    !settingModel ||
    !settingModelSelect ||
    !btnFetchModels ||
    !settingTemperature ||
    !settingMaxTokens ||
    !settingMaxContextTokens ||
    !advancedSettingsToggle ||
    !advancedSettings ||
    !settingTopP ||
    !settingTopK ||
    !settingFrequencyPenalty ||
    !settingPresencePenalty ||
    !settingOpenaiReasoningEffort ||
    !settingDeepseekReasoningEffort ||
    !settingAnthropicThinkingEnabled ||
    !settingAnthropicThinkingBudget ||
    !btnSaveSettings ||
    !btnCancelSettings ||
    !btnInitializeSettings ||
    !toolbarProjectName ||
    !btnProjects ||
    !btnImport ||
    !editorSection ||
    !projectNav ||
    !episodeList ||
    !btnNewEpisode ||
    !navCharacters ||
    !navWorld ||
    !navRelationships ||
    !navMemos ||
    !episodeSummary ||
    !btnGenerateSummary ||
    !summarySection ||
    !btnPopoutSummary ||
    !memoSection ||
    !btnToggleMemo ||
    !btnPopoutMemo ||
    !episodeMemo ||
    !chatPanel ||
    !chatProviderSelect ||
    !chatModelSelect ||
    !btnToggleChat ||
    !btnPopoutChat ||
    !settingsSection ||
    !btnPopoutSettings ||
    !settingsPanel ||
    !memosSection ||
    !btnPopoutMemos ||
    !memosPanel ||
    !projectModal ||
    !projectList ||
    !projectTitleInput ||
    !btnCreateProject ||
    !btnCloseProjectModal ||
    !btnImportFolder ||
    !folderImportInput ||
    !importPreviewModal ||
    !importPreviewTitle ||
    !importPreviewList ||
    !btnConfirmImport ||
    !btnCancelImport ||
    !radioImportBodyAndSettings ||
    !radioImportSettingsOnly ||
    !chkImportDoubleCheck
  ) {
    throw new Error("Required DOM elements are missing");
  }

  elements = {
    editor,
    chatForm,
    chatInput,
    chatMessages,
    btnSend,
    btnCancel,
    btnContinue,
    btnRewrite,
    btnFeedback,
    btnSettings,
    btnGenreLibrary,
    toolbarProjectName,
    btnProjects,
    btnImport,
    editorSection,
    projectNav,
    episodeList,
    btnNewEpisode,
    navCharacters,
    navWorld,
    navRelationships,
    navMemos,
    episodeSummary,
    btnGenerateSummary,
    summarySection,
    btnPopoutSummary,
    memoSection,
    btnToggleMemo,
    btnPopoutMemo,
    episodeMemo,
    chatPanel,
    chatProviderSelect,
    chatModelSelect,
    btnToggleChat,
    btnPopoutChat,
    settingsSection,
    btnPopoutSettings,
    settingsPanel,
    memosSection,
    btnPopoutMemos,
    memosPanel,
    settingsModal,
    settingsForm,
    settingProvider,
    settingApiKey,
    settingBaseUrl,
    settingModel,
    settingModelSelect,
    btnFetchModels,
    settingTemperature,
    settingMaxTokens,
    settingMaxContextTokens,
    advancedSettingsToggle,
    advancedSettings,
    settingTopP,
    settingTopK,
    settingFrequencyPenalty,
    settingPresencePenalty,
    settingOpenaiReasoningEffort,
    settingDeepseekReasoningEffort,
    settingAnthropicThinkingEnabled,
    settingAnthropicThinkingBudget,
    btnSaveSettings,
    btnCancelSettings,
    btnInitializeSettings,
    projectModal,
    projectList,
    projectTitleInput,
    btnCreateProject,
    btnCloseProjectModal,
    btnImportFolder,
    folderImportInput,
    importPreviewModal,
    importPreviewTitle,
    importPreviewList,
    btnConfirmImport,
    btnCancelImport,
    radioImportBodyAndSettings,
    radioImportSettingsOnly,
    chkImportDoubleCheck,
  };

  return elements;
}
