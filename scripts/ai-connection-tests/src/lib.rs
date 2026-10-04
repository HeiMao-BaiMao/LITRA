//! Headless tests of actual production AI modules. No desktop, keyring,
//! browser launch, or live provider access is available in this harness.
#![allow(dead_code)]
extern crate self as tauri;
extern crate self as tauri_plugin_opener;
pub use tauri_command::command;

pub struct AppHandle;
pub struct PathResolver;
pub trait Manager {
    fn path(&self) -> PathResolver {
        PathResolver
    }
}
impl Manager for AppHandle {}
impl PathResolver {
    pub fn app_data_dir(&self) -> Result<std::path::PathBuf, String> {
        Err("App paths disabled in headless tests".into())
    }
    pub fn app_config_dir(&self) -> Result<std::path::PathBuf, String> {
        Err("App paths disabled in headless tests".into())
    }
    pub fn resource_dir(&self) -> Result<std::path::PathBuf, String> {
        Err("App paths disabled in headless tests".into())
    }
}
pub mod webdav_sync {
    pub fn save_webdav_sync_config(_: ()) -> Result<(), String> {
        panic!("WebDAV settings disabled in headless tests")
    }
}
pub struct State<'a, T> {
    inner: &'a T,
}
impl<T> std::ops::Deref for State<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        self.inner
    }
}
pub fn open_url(_: &str, _: Option<&str>) -> Result<(), String> {
    Err("Browser access disabled in connection tests".into())
}
pub mod ipc {
    use std::{marker::PhantomData, sync::Arc};
    pub enum InvokeResponseBody {
        Json(String),
    }
    impl InvokeResponseBody {
        pub fn deserialize<T: serde::de::DeserializeOwned>(self) -> serde_json::Result<T> {
            match self {
                Self::Json(value) => serde_json::from_str(&value),
            }
        }
    }
    pub struct Channel<T> {
        callback: Arc<dyn Fn(InvokeResponseBody) -> Result<(), String> + Send + Sync>,
        marker: PhantomData<T>,
    }
    impl<T: serde::Serialize> Channel<T> {
        pub fn new<F: Fn(InvokeResponseBody) -> Result<(), String> + Send + Sync + 'static>(
            callback: F,
        ) -> Self {
            Self {
                callback: Arc::new(callback),
                marker: PhantomData,
            }
        }
        pub fn send(&self, event: T) -> Result<(), String> {
            (self.callback)(InvokeResponseBody::Json(
                serde_json::to_string(&event).unwrap(),
            ))
        }
    }
}
pub mod secrets {
    // Any unexpected use is a test failure; persistence tests inject an
    // in-memory store directly instead of touching OS credentials.
    pub fn get_secret(_: &str) -> Result<Option<String>, String> {
        panic!("Live credential reads disabled")
    }
    pub fn set_secret(_: &str, _: &str) -> Result<(), String> {
        panic!("Live credential writes disabled")
    }
    pub fn delete_secret(_: &str) -> Result<(), String> {
        panic!("Live credential deletes disabled")
    }
    pub fn set_or_delete_secret(_: &str, _: Option<&str>) -> Result<(), String> {
        panic!("Live credential writes disabled")
    }
}
pub mod ai {
    include!(concat!(env!("OUT_DIR"), "/ai.rs"));
}
#[path = "../../../src-tauri/src/codex_oauth.rs"]
pub mod codex_oauth;

#[path = "../../../src-tauri/src/settings/updates.rs"]
mod settings_updates;
