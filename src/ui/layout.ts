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
  settingBackgroundProvider: HTMLSelectElement;
  settingBackgroundModel: HTMLSelectElement;
  settingApiKey: HTMLInputElement;
  settingBaseUrl: HTMLInputElement;
  settingModel: HTMLInputElement;
  settingModelSelect: HTMLSelectElement;
  btnFetchModels: HTMLButtonElement;
  settingTemperature: HTMLInputElement;
  settingMaxTokens: HTMLInputElement;
  settingMaxContextTokens: HTMLInputElement;
  settingChatSubmitShortcut: HTMLSelectElement;
  advancedSettingsToggle: HTMLButtonElement;
  advancedSettings: HTMLElement;
  settingTopP: HTMLInputElement;
  settingTopK: HTMLInputElement;
  settingFrequencyPenalty: HTMLInputElement;
  settingPresencePenalty: HTMLInputElement;
  settingOpenaiReasoningEffort: HTMLSelectElement;
  settingDeepseekReasoningEffort: HTMLSelectElement;
  settingDeepseekThinking: HTMLInputElement;
  settingAnthropicThinkingEnabled: HTMLInputElement;
  settingAnthropicThinkingBudget: HTMLInputElement;
  settingGoogleThinkingLevel: HTMLSelectElement;
  settingTwoStageContinuation: HTMLInputElement;
  settingContinuationReview: HTMLInputElement;
  settingJudgmentSource: HTMLSelectElement;
  settingJudgmentProvider: HTMLSelectElement;
  settingJudgmentModel: HTMLSelectElement;
  settingWritingTemperature: HTMLInputElement;
  settingWritingTopP: HTMLInputElement;
  settingWritingScaffold: HTMLSelectElement;
  settingWritingDeepseekThinking: HTMLSelectElement;
  settingJudgmentTemperature: HTMLInputElement;
  settingJudgmentTopP: HTMLInputElement;
  settingJudgmentScaffold: HTMLSelectElement;
  settingJudgmentDeepseekThinking: HTMLSelectElement;
  settingContinuationSceneState: HTMLInputElement;
  settingContinuationCharacterVoice: HTMLInputElement;
  settingContinuationBestOfTwo: HTMLInputElement;
  settingContinuationTargetedRevision: HTMLInputElement;
  settingContinuationBeatSplit: HTMLInputElement;
  settingWebdavEnabled: HTMLInputElement;
  settingWebdavUrl: HTMLInputElement;
  settingWebdavUsername: HTMLInputElement;
  settingWebdavPassword: HTMLInputElement;
  settingWebdavFolder: HTMLInputElement;
  settingExaApiKey: HTMLInputElement;
  btnSaveSettings: HTMLButtonElement;
  btnCancelSettings: HTMLButtonElement;
  btnInitializeSettings: HTMLButtonElement;
  btnShowLicenses: HTMLButtonElement;
  licenseModal: HTMLElement;
  licenseContent: HTMLElement;
  btnCloseLicenses: HTMLButtonElement;
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
  const settingBackgroundProvider = document.querySelector<HTMLSelectElement>("#setting-background-provider");
  const settingBackgroundModel = document.querySelector<HTMLSelectElement>("#setting-background-model");
  const settingApiKey = document.querySelector<HTMLInputElement>("#setting-api-key");
  const settingBaseUrl = document.querySelector<HTMLInputElement>("#setting-base-url");
  const settingModel = document.querySelector<HTMLInputElement>("#setting-model");
  const settingModelSelect = document.querySelector<HTMLSelectElement>("#setting-model-select");
  const btnFetchModels = document.querySelector<HTMLButtonElement>("#btn-fetch-models");
  const settingTemperature = document.querySelector<HTMLInputElement>("#setting-temperature");
  const settingMaxTokens = document.querySelector<HTMLInputElement>("#setting-max-tokens");
  const settingMaxContextTokens = document.querySelector<HTMLInputElement>("#setting-max-context-tokens");
  const settingChatSubmitShortcut = document.querySelector<HTMLSelectElement>("#setting-chat-submit-shortcut");
  const advancedSettingsToggle = document.querySelector<HTMLButtonElement>("#advanced-settings-toggle");
  const advancedSettings = document.querySelector<HTMLElement>("#advanced-settings");
  const settingTopP = document.querySelector<HTMLInputElement>("#setting-top-p");
  const settingTopK = document.querySelector<HTMLInputElement>("#setting-top-k");
  const settingFrequencyPenalty = document.querySelector<HTMLInputElement>("#setting-frequency-penalty");
  const settingPresencePenalty = document.querySelector<HTMLInputElement>("#setting-presence-penalty");
  const settingOpenaiReasoningEffort = document.querySelector<HTMLSelectElement>("#setting-openai-reasoning-effort");
  const settingDeepseekReasoningEffort = document.querySelector<HTMLSelectElement>("#setting-deepseek-reasoning-effort");
  const settingDeepseekThinking = document.querySelector<HTMLInputElement>("#setting-deepseek-thinking");
  const settingAnthropicThinkingEnabled = document.querySelector<HTMLInputElement>("#setting-anthropic-thinking-enabled");
  const settingAnthropicThinkingBudget = document.querySelector<HTMLInputElement>("#setting-anthropic-thinking-budget");
  const settingGoogleThinkingLevel = document.querySelector<HTMLSelectElement>("#setting-google-thinking-level");
  const settingTwoStageContinuation = document.querySelector<HTMLInputElement>("#setting-two-stage-continuation");
  const settingContinuationReview = document.querySelector<HTMLInputElement>("#setting-continuation-review");
  const settingJudgmentSource = document.querySelector<HTMLSelectElement>("#setting-judgment-source");
  const settingJudgmentProvider = document.querySelector<HTMLSelectElement>("#setting-judgment-provider");
  const settingJudgmentModel = document.querySelector<HTMLSelectElement>("#setting-judgment-model");
  const settingWritingTemperature = document.querySelector<HTMLInputElement>("#setting-writing-temperature");
  const settingWritingTopP = document.querySelector<HTMLInputElement>("#setting-writing-top-p");
  const settingWritingScaffold = document.querySelector<HTMLSelectElement>("#setting-writing-scaffold");
  const settingWritingDeepseekThinking = document.querySelector<HTMLSelectElement>("#setting-writing-deepseek-thinking");
  const settingJudgmentTemperature = document.querySelector<HTMLInputElement>("#setting-judgment-temperature");
  const settingJudgmentTopP = document.querySelector<HTMLInputElement>("#setting-judgment-top-p");
  const settingJudgmentScaffold = document.querySelector<HTMLSelectElement>("#setting-judgment-scaffold");
  const settingJudgmentDeepseekThinking = document.querySelector<HTMLSelectElement>("#setting-judgment-deepseek-thinking");
  const settingContinuationSceneState = document.querySelector<HTMLInputElement>("#setting-continuation-scene-state");
  const settingContinuationCharacterVoice = document.querySelector<HTMLInputElement>("#setting-continuation-character-voice");
  const settingContinuationBestOfTwo = document.querySelector<HTMLInputElement>("#setting-continuation-best-of-two");
  const settingContinuationTargetedRevision = document.querySelector<HTMLInputElement>("#setting-continuation-targeted-revision");
  const settingContinuationBeatSplit = document.querySelector<HTMLInputElement>("#setting-continuation-beat-split");
  const settingWebdavEnabled = document.querySelector<HTMLInputElement>("#setting-webdav-enabled");
  const settingWebdavUrl = document.querySelector<HTMLInputElement>("#setting-webdav-url");
  const settingWebdavUsername = document.querySelector<HTMLInputElement>("#setting-webdav-username");
  const settingWebdavPassword = document.querySelector<HTMLInputElement>("#setting-webdav-password");
  const settingWebdavFolder = document.querySelector<HTMLInputElement>("#setting-webdav-folder");
  const settingExaApiKey = document.querySelector<HTMLInputElement>("#setting-exa-api-key");
  const btnSaveSettings = document.querySelector<HTMLButtonElement>("#btn-save-settings");
  const btnCancelSettings = document.querySelector<HTMLButtonElement>("#btn-cancel-settings");
  const btnInitializeSettings = document.querySelector<HTMLButtonElement>("#btn-initialize-settings");
  const btnShowLicenses = document.querySelector<HTMLButtonElement>("#btn-show-licenses");
  const licenseModal = document.querySelector<HTMLElement>("#license-modal");
  const licenseContent = document.querySelector<HTMLElement>("#license-content");
  const btnCloseLicenses = document.querySelector<HTMLButtonElement>("#btn-close-licenses");
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
    !settingBackgroundProvider ||
    !settingBackgroundModel ||
    !settingApiKey ||
    !settingBaseUrl ||
    !settingModel ||
    !settingModelSelect ||
    !btnFetchModels ||
    !settingTemperature ||
    !settingMaxTokens ||
    !settingMaxContextTokens ||
    !settingChatSubmitShortcut ||
    !advancedSettingsToggle ||
    !advancedSettings ||
    !settingTopP ||
    !settingTopK ||
    !settingFrequencyPenalty ||
    !settingPresencePenalty ||
    !settingOpenaiReasoningEffort ||
    !settingDeepseekReasoningEffort ||
    !settingDeepseekThinking ||
    !settingAnthropicThinkingEnabled ||
    !settingAnthropicThinkingBudget ||
    !settingGoogleThinkingLevel ||
    !settingTwoStageContinuation ||
    !settingContinuationReview ||
    !settingJudgmentSource ||
    !settingJudgmentProvider ||
    !settingJudgmentModel ||
    !settingWritingTemperature ||
    !settingWritingTopP ||
    !settingWritingScaffold ||
    !settingWritingDeepseekThinking ||
    !settingJudgmentTemperature ||
    !settingJudgmentTopP ||
    !settingJudgmentScaffold ||
    !settingJudgmentDeepseekThinking ||
    !settingContinuationSceneState ||
    !settingContinuationCharacterVoice ||
    !settingContinuationBestOfTwo ||
    !settingContinuationTargetedRevision ||
    !settingContinuationBeatSplit ||
    !settingWebdavEnabled ||
    !settingWebdavUrl ||
    !settingWebdavUsername ||
    !settingWebdavPassword ||
    !settingWebdavFolder ||
    !settingExaApiKey ||
    !btnSaveSettings ||
    !btnCancelSettings ||
    !btnInitializeSettings ||
    !btnShowLicenses ||
    !licenseModal ||
    !licenseContent ||
    !btnCloseLicenses ||
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
    settingBackgroundProvider,
    settingBackgroundModel,
    settingApiKey,
    settingBaseUrl,
    settingModel,
    settingModelSelect,
    btnFetchModels,
    settingTemperature,
    settingMaxTokens,
    settingMaxContextTokens,
    settingChatSubmitShortcut,
    advancedSettingsToggle,
    advancedSettings,
    settingTopP,
    settingTopK,
    settingFrequencyPenalty,
    settingPresencePenalty,
    settingOpenaiReasoningEffort,
    settingDeepseekReasoningEffort,
    settingDeepseekThinking,
    settingAnthropicThinkingEnabled,
    settingAnthropicThinkingBudget,
    settingGoogleThinkingLevel,
    settingTwoStageContinuation,
    settingContinuationReview,
    settingJudgmentSource,
    settingJudgmentProvider,
    settingJudgmentModel,
    settingWritingTemperature,
    settingWritingTopP,
    settingWritingScaffold,
    settingWritingDeepseekThinking,
    settingJudgmentTemperature,
    settingJudgmentTopP,
    settingJudgmentScaffold,
    settingJudgmentDeepseekThinking,
    settingContinuationSceneState,
    settingContinuationCharacterVoice,
    settingContinuationBestOfTwo,
    settingContinuationTargetedRevision,
    settingContinuationBeatSplit,
    settingWebdavEnabled,
    settingWebdavUrl,
    settingWebdavUsername,
    settingWebdavPassword,
    settingWebdavFolder,
    settingExaApiKey,
    btnSaveSettings,
    btnCancelSettings,
    btnInitializeSettings,
    btnShowLicenses,
    licenseModal,
    licenseContent,
    btnCloseLicenses,
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
