use reqwest::{header, RequestBuilder};

pub(super) fn apply_request(builder: RequestBuilder) -> RequestBuilder {
    builder
        .header("x-opencode-client", "litra")
        .header(header::USER_AGENT, "litra/1.0")
}
