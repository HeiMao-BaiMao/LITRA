use serde_json::{Map, Value};

/// Preserve stable record identity so relationships and references remain valid.
/// Check before applying any field, so invalid updates are all-or-nothing.
pub(super) fn merge_updates(target: &mut Value, updates: Map<String, Value>) -> Result<(), String> {
    let object = target
        .as_object_mut()
        .ok_or_else(|| "設定データの形式が不正です。".to_owned())?;
    if let Some(id) = updates.get("id") {
        if object.get("id") != Some(id) {
            return Err("設定の ID は変更できません。内容の項目だけを更新してください。".into());
        }
    }
    object.extend(updates);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn changing_record_id_rejects_entire_update() {
        let mut target = json!({"id":"original", "name":"蓮"});
        let original = target.clone();
        let updates = json!({"id":"replacement", "name":"春香"})
            .as_object()
            .unwrap()
            .clone();
        assert!(merge_updates(&mut target, updates).is_err());
        assert_eq!(target, original);
    }

    #[test]
    fn custom_fields_and_redundant_same_id_are_preserved() {
        let mut target = json!({"id":"original", "name":"蓮"});
        let updates = json!({"id":"original", "name":"春香", "custom":{"note":"設定"}})
            .as_object()
            .unwrap()
            .clone();
        merge_updates(&mut target, updates).unwrap();
        assert_eq!(
            target,
            json!({"id":"original", "name":"春香", "custom":{"note":"設定"}})
        );
    }
}
