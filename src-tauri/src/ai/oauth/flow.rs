use std::sync::{Arc, Mutex};

use tokio_util::sync::CancellationToken;

/// Each attempt owns a token. Starting another attempt must never reset the
/// cancellation state of an older request still awaiting the network/keyring.
#[derive(Clone, Default)]
pub(crate) struct OAuthFlow(Arc<Mutex<Option<CancellationToken>>>);

pub(crate) struct OAuthAttempt {
    flow: OAuthFlow,
    pub token: CancellationToken,
}

impl OAuthFlow {
    pub fn begin(&self) -> Result<OAuthAttempt, String> {
        let mut active = self.0.lock().map_err(|_| "OAuth state lock failed")?;
        if active.is_some() {
            return Err(
                "認証処理が進行中です。完了またはキャンセルを待って再試行してください。".into(),
            );
        }
        let token = CancellationToken::new();
        *active = Some(token.clone());
        Ok(OAuthAttempt {
            flow: self.clone(),
            token,
        })
    }

    pub fn cancel(&self) {
        if let Ok(active) = self.0.lock() {
            if let Some(token) = active.as_ref() {
                token.cancel();
            }
        }
    }
}

impl OAuthAttempt {
    pub fn check(&self) -> Result<(), String> {
        if self.token.is_cancelled() {
            Err("認証がキャンセルされました。".into())
        } else {
            Ok(())
        }
    }
}

impl Drop for OAuthAttempt {
    fn drop(&mut self) {
        // Also releases callback threads when their async owner fails/drops.
        self.token.cancel();
        if let Ok(mut active) = self.flow.0.lock() {
            active.take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_start_cannot_revive_a_cancelled_attempt() {
        let flow = OAuthFlow::default();
        let first = flow.begin().unwrap();
        assert!(flow.begin().is_err());
        flow.cancel();
        assert!(first.check().is_err());
        assert!(flow.begin().is_err());
        drop(first);
        assert!(flow.begin().unwrap().check().is_ok());
    }

    #[test]
    fn dropping_attempt_cancels_background_work_and_releases_slot() {
        let flow = OAuthFlow::default();
        let attempt = flow.begin().unwrap();
        let background = attempt.token.clone();
        drop(attempt);
        assert!(background.is_cancelled());
        assert!(flow.begin().is_ok());
    }
}
