#![allow(dead_code)]

use serde_json::{Value, json};

/// Builds a YouTube Music history response from `(heading, plays)` shelves.
/// Each play is a `(title, artist)` pair.
pub fn history_json(shelves: &[(&str, &[(&str, &str)])]) -> Value {
    build_history(shelves, item)
}

/// Like `history_json`, but each play's `(title, uploader)` pair links its
/// second run to the uploader's channel instead of an artist page, as a video
/// a channel uploaded does.
pub fn upload_history_json(shelves: &[(&str, &[(&str, &str)])]) -> Value {
    build_history(shelves, upload_item)
}

fn build_history(shelves: &[(&str, &[(&str, &str)])], item: fn(&str, &str) -> Value) -> Value {
    let shelves: Vec<Value> = shelves
        .iter()
        .map(|(heading, plays)| {
            let items: Vec<Value> = plays
                .iter()
                .map(|(title, artist)| item(title, artist))
                .collect();
            json!({"musicShelfRenderer": {
                "title": {"runs": [{"text": heading}]},
                "contents": items,
            }})
        })
        .collect();

    json!({"contents": {"singleColumnBrowseResultsRenderer": {"tabs": [{
        "tabRenderer": {"content": {"sectionListRenderer": {"contents": shelves}}}
    }]}}})
}

pub fn video_id_for(title: &str) -> String {
    title
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

fn item(title: &str, artist: &str) -> Value {
    json!({"musicResponsiveListItemRenderer": {"flexColumns": [
        watch_column(title),
        link_column(artist, "MUSIC_PAGE_TYPE_ARTIST"),
    ]}})
}

fn upload_item(title: &str, uploader: &str) -> Value {
    let mut column = link_column(uploader, "MUSIC_PAGE_TYPE_USER_CHANNEL");
    column
        .pointer_mut("/musicResponsiveListItemFlexColumnRenderer/text/runs")
        .and_then(Value::as_array_mut)
        .unwrap()
        .extend([json!({"text": " • "}), json!({"text": "1k views"})]);
    json!({"musicResponsiveListItemRenderer": {"flexColumns": [
        watch_column(title),
        column,
    ]}})
}

fn watch_column(title: &str) -> Value {
    json!({"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{
        "text": title,
        "navigationEndpoint": {"watchEndpoint": {"videoId": video_id_for(title)}},
    }]}}})
}

fn link_column(text: &str, page_type: &str) -> Value {
    json!({"musicResponsiveListItemFlexColumnRenderer": {"text": {"runs": [{
        "text": text,
        "navigationEndpoint": {"browseEndpoint": {
            "browseEndpointContextSupportedConfigs": {
                "browseEndpointContextMusicConfig": {"pageType": page_type}
            }
        }},
    }]}}})
}

/// Wraps history JSON in the JavaScript string used by YouTube Music, on a
/// signed-in page. Structural characters use `\xNN` escapes, while non-ASCII
/// text stays raw.
pub fn history_page(json: &Value) -> String {
    page_with_sign_in(json, r#"ytcfg.set({"LOGGED_IN":true});"#)
}

/// The page YouTube Music returns for a cookie that is no longer signed in.
pub fn signed_out_page() -> String {
    page_with_sign_in(&history_json(&[]), r#"ytcfg.set({"LOGGED_IN":false});"#)
}

fn page_with_sign_in(json: &Value, ytcfg: &str) -> String {
    let escaped = json
        .to_string()
        .replace('{', "\\x7b")
        .replace('}', "\\x7d")
        .replace('"', "\\x22");

    format!(
        "<script>{ytcfg}</script><script>initialData.push({{path: '/browse', data: '{escaped}'}});ytcfg.set({{'YTMUSIC_INITIAL_DATA': initialData}});</script>"
    )
}
