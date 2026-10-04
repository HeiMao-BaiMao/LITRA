//! Validate model-supplied calls against the exact tool catalog offered this turn.
//! Schemas are application-owned; this implements the subset used by our catalogs.
use serde_json::Value;

pub fn validate_call(definitions: &[Value], name: &str, input: &Value) -> Result<(), String> {
    let definition = definitions
        .iter()
        .find(|tool| tool["name"].as_str() == Some(name))
        .ok_or_else(|| format!("Tool '{name}' is not available in this turn"))?;
    validate(&definition["inputSchema"], input, "$", 0)
}

fn validate(schema: &Value, input: &Value, path: &str, depth: usize) -> Result<(), String> {
    if depth > 64 {
        return Err(format!("{path}: argument nesting is too deep"));
    }
    if let Some(kind) = schema.get("type").and_then(Value::as_str) {
        let valid = match kind {
            "object" => input.is_object(),
            "array" => input.is_array(),
            "string" => input.is_string(),
            "boolean" => input.is_boolean(),
            "integer" => input.is_i64() || input.is_u64(),
            "number" => input.is_number(),
            "null" => input.is_null(),
            _ => false,
        };
        if !valid {
            return Err(format!("{path}: expected {kind}"));
        }
    }
    if let Some(values) = schema.get("enum").and_then(Value::as_array) {
        if !values.contains(input) {
            return Err(format!("{path}: unsupported enum value"));
        }
    }
    if let Some(object) = input.as_object() {
        if let Some(required) = schema.get("required").and_then(Value::as_array) {
            for key in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(key) {
                    return Err(format!("{path}.{key}: required argument is missing"));
                }
            }
        }
        for (key, value) in object {
            if let Some(child) = schema.get("properties").and_then(|props| props.get(key)) {
                validate(child, value, &format!("{path}.{key}"), depth + 1)?;
            } else if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                return Err(format!("{path}.{key}: unknown argument"));
            } else if let Some(child) = schema.get("additionalProperties").filter(|s| s.is_object())
            {
                validate(child, value, &format!("{path}.{key}"), depth + 1)?;
            }
        }
    }
    if let Some(items) = input.as_array() {
        for (bound, too_many) in [("minItems", false), ("maxItems", true)] {
            if let Some(limit) = schema.get(bound).and_then(Value::as_u64) {
                if (too_many && items.len() as u64 > limit)
                    || (!too_many && (items.len() as u64) < limit)
                {
                    return Err(format!("{path}: violates {bound}={limit}"));
                }
            }
        }
        if let Some(child) = schema.get("items") {
            for (index, value) in items.iter().enumerate() {
                validate(child, value, &format!("{path}[{index}]"), depth + 1)?;
            }
        }
    }
    if let Some(number) = input.as_f64() {
        for (bound, maximum) in [("minimum", false), ("maximum", true)] {
            if let Some(limit) = schema.get(bound).and_then(Value::as_f64) {
                if (maximum && number > limit) || (!maximum && number < limit) {
                    return Err(format!("{path}: violates {bound}={limit}"));
                }
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn catalog() -> Vec<Value> {
        vec![json!({"name":"edit","inputSchema":{
            "type":"object", "required":["edits"], "additionalProperties":false,
            "properties":{"edits":{"type":"array","minItems":1,"maxItems":2,"items":{
                "type":"object","required":["line","mode"],"additionalProperties":false,
                "properties":{"line":{"type":"integer","minimum":1},"mode":{"type":"string","enum":["replace"]}}
            }}}
        }})]
    }
    #[test]
    fn rejects_unoffered_tools_and_non_objects() {
        assert!(validate_call(&catalog(), "hidden", &json!({})).is_err());
        assert!(validate_call(&catalog(), "edit", &json!(null)).is_err());
        assert!(validate_call(&catalog(), "edit", &json!({})).is_err());
    }
    #[test]
    fn checks_nested_types_bounds_enums_and_unknown_fields() {
        for input in [
            json!({"edits":[]}),
            json!({"edits":[{"line":0,"mode":"replace"}]}),
            json!({"edits":[{"line":1.5,"mode":"replace"}]}),
            json!({"edits":[{"line":1,"mode":"delete"}]}),
            json!({"edits":[{"line":1,"mode":"replace","extra":true}]}),
            json!({"edits":[{"line":1,"mode":"replace"}],"projectId":"other"}),
        ] {
            assert!(
                validate_call(&catalog(), "edit", &input).is_err(),
                "{input}"
            );
        }
        assert!(validate_call(
            &catalog(),
            "edit",
            &json!({"edits":[{"line":1,"mode":"replace"}]})
        )
        .is_ok());
    }
}
