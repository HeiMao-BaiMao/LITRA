use serde::Deserialize;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatTransportMetadata {
    pub provider: Option<String>,
    pub model: Option<String>,
    pub response_model_id: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub id: Option<String>,
    pub role: String,
    pub content: String,
    pub thinking: Option<String>,
    pub transport: Option<ChatTransportMetadata>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSyncPayload {
    pub messages: Vec<ChatMessage>,
    pub is_generating: bool,
    pub direct_writing_enabled: bool,
}

#[derive(Clone, Deserialize)]
pub struct ProviderModel {
    pub id: String,
    pub label: Option<String>,
}

#[derive(Clone, Deserialize)]
pub struct ProviderEntry {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub models: Vec<ProviderModel>,
}

#[derive(Clone, Default, Deserialize)]
pub struct ProviderConfig {
    #[serde(default)]
    pub providers: Vec<ProviderEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSettingsSyncPayload {
    pub provider: String,
    pub model: String,
    pub chat_submit_shortcut: Option<String>,
    pub provider_config: ProviderConfig,
}
