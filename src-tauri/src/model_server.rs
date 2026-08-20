//! What a local model server says about the model it has loaded right now.
//!
//! Everything else that describes a model in Gofer is written down: the settings file the user
//! picked into, and Pi's `models.json` beside it. Both are copies made once. A llama.cpp host is
//! not — it serves whatever `.gguf` it was started with, the user swaps that file whenever they
//! like, and neither copy ever hears about it. That is how a model with no reasoning levels kept a
//! reasoning menu: the catalogue did not name the loaded file, so its *server's* flag answered for
//! it, and the server-wide flag is a property of the address, not of the model at it.
//!
//! `/props` is the one source that changes when the file does. llama.cpp answers it with the
//! capabilities of the chat template it actually loaded, so it is asked on every settings read and
//! its answer outranks both copies.
//!
//! Spoken over a raw socket rather than through `reqwest`, because the readers are synchronous and
//! some of them run on a Tokio worker — the same reason `godot_rpc` and `godot_dap` do. The cost is
//! that only `http` is understood. A local inference server behind TLS gets no answer here and
//! keeps the catalogue's, which is what every build before this one did for all of them.

use serde::Deserialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long one probe may take, end to end. A local server answers in about a millisecond and one
/// that is not running refuses instantly, so this only bounds the third case: a host that accepts
/// the connection and then says nothing.
pub(crate) const PROBE_TIMEOUT: Duration = Duration::from_millis(750);

/// How long an answer stands before the server is asked again.
///
/// Settings are read on a great many paths, several of which are hot. Three seconds is short enough
/// that swapping the model and opening the settings page shows the new one, and long enough that a
/// burst of reads costs one round trip rather than a hundred.
const CACHE_TTL: Duration = Duration::from_secs(3);

/// Longest `/props` body that will be read. The real one is about 10 KB, most of it the chat
/// template. A ceiling, because a socket is being read to exhaustion.
const MAX_BODY_BYTES: usize = 1024 * 1024;

/// The model a server has loaded, as the server describes it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ServedModel {
    /// The id the server answers to. For llama.cpp this is the path of the file it was started
    /// with, which is almost never the id a catalogue names the same model by.
    pub(crate) id: String,
    /// The window the server was started with, which is not the one the weights were trained for.
    pub(crate) context_window: Option<u64>,
    /// Whether the loaded chat template thinks at all.
    pub(crate) reasoning: bool,
    /// The efforts this template will accept, in Gofer's words, or empty when it takes none.
    ///
    /// A list rather than a flag, because the template refuses the ones it does not know — it
    /// raises, and llama.cpp answers the whole request with HTTP 500. A Qwen build accepts three
    /// of Gofer's seven levels and blows up on two of them, so "does it take an effort" was never
    /// the question. "Which ones" is.
    pub(crate) efforts: Vec<String>,
    /// What it accepts, in Gofer's words. Absent when the server does not report its modalities
    /// at all — an older llama.cpp — because answering `["text"]` anyway would take the composer's
    /// image control away from a model that reads pictures perfectly well.
    pub(crate) input: Option<Vec<String>>,
    /// Whether this is the only model the server has. `/props` describes one model, and llama.cpp
    /// also has a router mode that serves many — where the one `/props` names is not necessarily
    /// the one the user picked, and adopting its id would silently switch them to another model.
    pub(crate) sole: bool,
}

/// One answer and when it was given. The answer itself is optional — see `cached`.
type CachedAnswer = (Instant, Option<ServedModel>);

static CACHE: Mutex<Option<HashMap<String, CachedAnswer>>> = Mutex::new(None);

/// Asks a server what it is serving, at most once every `CACHE_TTL` per address.
///
/// `None` is not a failure to report. It means this address did not answer the question — it is not
/// a llama.cpp host, or it is not running — and the caller keeps whatever it already had.
pub(crate) fn served_model(base_url: &str) -> Option<ServedModel> {
    let key = base_url.trim().trim_end_matches('/').to_owned();
    if let Some(cached) = cached(&key) {
        return cached;
    }
    let fresh = probe(&key);
    remember(key, fresh.clone());
    fresh
}

/// The cached answer for one address, or `None` when there is none young enough to use.
///
/// Doubly optional on purpose: the outer `None` means *nothing was cached*, the inner one means
/// *this address was asked and had no answer*. Collapsing them would re-probe a server that is not
/// there on every single settings read.
fn cached(key: &str) -> Option<Option<ServedModel>> {
    let cache = CACHE.lock().ok()?;
    let (stored, model) = cache.as_ref()?.get(key)?;
    (stored.elapsed() < CACHE_TTL).then(|| model.clone())
}

fn remember(key: String, model: Option<ServedModel>) {
    if let Ok(mut cache) = CACHE.lock() {
        cache
            .get_or_insert_with(HashMap::new)
            .insert(key, (Instant::now(), model));
    }
}

fn probe(base_url: &str) -> Option<ServedModel> {
    let (authority, props, models) = probe_targets(base_url)?;
    let mut served = parse_props(&get(&authority, &props)?)?;
    // A second round trip, to the endpoint the OpenAI client already uses. It is the only way to
    // tell a host serving one file from a router serving a directory of them.
    served.sole = get(&authority, &models).as_deref().and_then(count_models) == Some(1);
    Some(served)
}

/// Reads how many models a `/v1/models` body lists. `None` when it is not one of those bodies.
fn count_models(body: &str) -> Option<usize> {
    #[derive(Deserialize)]
    struct Models {
        data: Vec<serde_json::Value>,
    }
    serde_json::from_str::<Models>(body)
        .ok()
        .map(|models| models.data.len())
}

/// The two paths this asks about, for a base URL that points at an OpenAI-compatible endpoint.
///
/// They sit at different roots. The `/v1` an OpenAI client needs is not part of llama.cpp's own
/// surface — it answers `/props` at its root and 404s `/v1/props` — while `models` is an OpenAI
/// endpoint and stays where the base URL put it.
fn probe_targets(base_url: &str) -> Option<(String, String, String)> {
    let url = reqwest::Url::parse(base_url).ok()?;
    if url.scheme() != "http" {
        return None;
    }
    let host = url.host_str()?;
    let authority = format!("{host}:{}", url.port_or_known_default().unwrap_or(80));
    let api = url.path().trim_end_matches('/');
    let root = api.strip_suffix("/v1").unwrap_or(api);
    Some((authority, format!("{root}/props"), format!("{api}/models")))
}

/// One HTTP/1.1 GET, spoken by hand.
///
/// `Connection: close` is asked for, so the ordinary end of the body is EOF. It is asked for rather
/// than relied on: a reverse proxy, a TLS sidecar or an older cpp-httplib may honour keep-alive
/// anyway, and then EOF never comes. So the length is read when there is one and the socket is left
/// alone the moment the body is whole — and a read that fails keeps what it already had rather than
/// throwing away a complete answer to report that this is not a llama.cpp host.
fn get(authority: &str, path: &str) -> Option<String> {
    let deadline = Instant::now() + PROBE_TIMEOUT;
    let address = authority.to_socket_addrs().ok()?.next()?;
    let mut stream = TcpStream::connect_timeout(&address, PROBE_TIMEOUT).ok()?;
    let remaining = deadline.checked_duration_since(Instant::now())?;
    stream.set_read_timeout(Some(remaining)).ok()?;
    stream.set_write_timeout(Some(remaining)).ok()?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: {authority}\r\nConnection: close\r\nAccept: application/json\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).ok()?;
    stream.flush().ok()?;
    let mut raw = Vec::new();
    let mut chunk = [0_u8; 8192];
    // A read that fails is the timeout in nearly every case, and by then `raw` may already hold the
    // whole response. Ending the loop on it keeps what was read; only an empty hand is no answer.
    while let Ok(read) = stream.read(&mut chunk) {
        if read == 0 {
            break;
        }
        raw.extend_from_slice(&chunk[..read]);
        if raw.len() > MAX_BODY_BYTES || Instant::now() >= deadline || is_complete(&raw) {
            break;
        }
    }
    let text = String::from_utf8(raw).ok()?;
    let (head, body) = text.split_once("\r\n\r\n")?;
    (head.starts_with("HTTP/1.1 200") || head.starts_with("HTTP/1.0 200")).then(|| body.to_owned())
}

/// Whether these bytes are a whole response, as far as `Content-Length` can say.
///
/// False for anything else — a body with no length, or one sent in chunks — which leaves those to
/// end the way they always did: at EOF, or at the deadline.
fn is_complete(raw: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(raw) else {
        return false;
    };
    let Some((head, body)) = text.split_once("\r\n\r\n") else {
        return false;
    };
    head.lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.trim().parse::<usize>().ok())
        .is_some_and(|length| body.len() >= length)
}

/// llama.cpp's `/props`, as the four questions Gofer asks of it.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct Props {
    model_path: String,
    #[serde(default)]
    model_alias: Option<String>,
    #[serde(default)]
    chat_template_caps: Option<ChatTemplateCaps>,
    #[serde(default)]
    chat_template: Option<String>,
    #[serde(default)]
    modalities: Option<Modalities>,
    #[serde(default)]
    default_generation_settings: Option<GenerationSettings>,
}

/// What the loaded chat template can be told, as llama.cpp reads the template itself.
#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct ChatTemplateCaps {
    /// True when the template has somewhere to put thinking. The nearest thing llama.cpp reports
    /// to "this model thinks" — there is no separate flag for it.
    #[serde(default)]
    supports_preserve_reasoning: bool,
    #[serde(default)]
    supports_reasoning_effort: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct Modalities {
    #[serde(default)]
    vision: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
struct GenerationSettings {
    #[serde(default)]
    n_ctx: Option<u64>,
}

/// Every level in Gofer's vocabulary, in the order a menu should offer them. `off` is not one:
/// it is the absence of an effort, not an effort.
const KNOWN_EFFORTS: &[&str] = &["minimal", "low", "medium", "high", "xhigh", "max"];

/// The efforts a chat template will accept, read out of the template itself.
///
/// Templates that take an effort guard it the same way — they list what they know and raise on
/// anything else. That list is the only honest source: llama.cpp reports *that* an effort is taken,
/// never which, and the two Qwen builds on one machine do not agree on the answer.
///
/// An empty result is the safe one. It means the guard could not be found, and the caller then
/// offers thinking as on or off rather than offering a level that might raise.
fn accepted_efforts(template: &str) -> Vec<String> {
    let Some(guard) = template.split("reasoning_effort not in").nth(1) else {
        return Vec::new();
    };
    let Some(list) = guard
        .split_once('(')
        .and_then(|(_, rest)| rest.split_once(')'))
    else {
        return Vec::new();
    };
    // Intersected with what Gofer can name, and in Gofer's order rather than the template's. A
    // template naming an effort this build has no word for is one the settings file could not hold.
    KNOWN_EFFORTS
        .iter()
        .filter(|effort| {
            list.0
                .split(',')
                .map(|named| named.trim().trim_matches(['\'', '"']))
                .any(|named| named == **effort)
        })
        .map(|effort| (*effort).to_owned())
        .collect()
}

/// Reads one `/props` body. Separate from the socket so a test can drive the real rules.
///
/// A body with no `chat_template_caps` is not llama.cpp answering — some other server has a
/// `/props` of its own — and gets no answer rather than a wrong one.
pub(crate) fn parse_props(body: &str) -> Option<ServedModel> {
    let props: Props = serde_json::from_str(body).ok()?;
    let caps = props.chat_template_caps?;
    let id = props
        .model_alias
        .filter(|alias| !alias.trim().is_empty())
        .unwrap_or(props.model_path);
    if id.trim().is_empty() {
        return None;
    }
    let input = props.modalities.map(|modalities| {
        if modalities.vision {
            vec!["text".to_owned(), "image".to_owned()]
        } else {
            vec!["text".to_owned()]
        }
    });
    Some(ServedModel {
        id,
        context_window: props
            .default_generation_settings
            .and_then(|settings| settings.n_ctx)
            .filter(|window| *window > 0),
        // Either cap means the template has a place for thinking. Effort implies it on its own: a
        // template that takes an effort and cannot think would have nothing to spend it on.
        reasoning: caps.supports_preserve_reasoning || caps.supports_reasoning_effort,
        // The cap says the template takes an effort. The template says which. Without both, a
        // level the user picked from a menu of seven is a 500 on every request of the turn.
        efforts: if caps.supports_reasoning_effort {
            props
                .chat_template
                .as_deref()
                .map(accepted_efforts)
                .unwrap_or_default()
        } else {
            Vec::new()
        },
        input,
        // Answered by the caller, which is the only one making the second round trip.
        sole: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_two_endpoints_sit_at_different_roots() {
        assert_eq!(
            probe_targets("http://127.0.0.1:8080/v1"),
            Some((
                "127.0.0.1:8080".to_owned(),
                "/props".to_owned(),
                "/v1/models".to_owned()
            ))
        );
    }

    #[test]
    fn keeps_a_prefix_that_is_not_the_openai_one() {
        assert_eq!(
            probe_targets("http://localhost:9000/llama/v1/"),
            Some((
                "localhost:9000".to_owned(),
                "/llama/props".to_owned(),
                "/llama/v1/models".to_owned()
            ))
        );
    }

    #[test]
    fn assumes_the_default_port_when_the_url_omits_it() {
        assert_eq!(
            probe_targets("http://example.test/v1"),
            Some((
                "example.test:80".to_owned(),
                "/props".to_owned(),
                "/v1/models".to_owned()
            ))
        );
    }

    #[test]
    fn refuses_tls_because_this_speaks_http_by_hand() {
        assert_eq!(probe_targets("https://example.test/v1"), None);
    }

    #[test]
    fn counts_what_a_models_endpoint_lists() {
        assert_eq!(count_models(r#"{"data":[{"id":"a"}]}"#), Some(1));
        assert_eq!(count_models(r#"{"data":[{"id":"a"},{"id":"b"}]}"#), Some(2));
        assert_eq!(count_models("not-json"), None);
    }

    /// The shape a real llama.cpp answers with, trimmed to the fields that are read.
    fn body(caps: &str, modalities: &str) -> String {
        format!(
            r#"{{"model_path":"/models/Qwen3.6-27B.gguf","model_alias":"/models/Qwen3.6-27B.gguf",
               "chat_template_caps":{caps},"modalities":{modalities},
               "default_generation_settings":{{"n_ctx":120064}}}}"#
        )
    }

    #[test]
    fn a_template_that_thinks_without_levels_is_not_a_template_with_levels() {
        let served = parse_props(&body(
            r#"{"supports_preserve_reasoning":true,"supports_reasoning_effort":false}"#,
            r#"{"vision":true,"audio":false}"#,
        ))
        .expect("a llama.cpp body is an answer");
        assert_eq!(served.id, "/models/Qwen3.6-27B.gguf");
        assert_eq!(served.context_window, Some(120_064));
        assert!(served.reasoning, "the template has a place for thinking");
        assert!(served.efforts.is_empty(), "and no levels to be asked at");
        assert_eq!(
            served.input.as_deref(),
            Some(&["text".to_owned(), "image".to_owned()][..])
        );
    }

    #[test]
    fn a_template_with_neither_cap_does_not_think() {
        let served = parse_props(&body(
            r#"{"supports_preserve_reasoning":false,"supports_reasoning_effort":false}"#,
            r#"{"vision":false}"#,
        ))
        .expect("a llama.cpp body is an answer");
        assert!(!served.reasoning);
        assert!(served.efforts.is_empty());
        assert_eq!(served.input.as_deref(), Some(&["text".to_owned()][..]));
    }

    #[test]
    fn effort_alone_still_means_it_thinks() {
        let served = parse_props(&body(
            r#"{"supports_reasoning_effort":true}"#,
            r#"{"vision":false}"#,
        ))
        .expect("a llama.cpp body is an answer");
        assert!(served.reasoning);
        // The cap alone is not a list. Without a template to read, thinking is on or off.
        assert!(served.efforts.is_empty());
    }

    #[test]
    fn reads_the_levels_a_template_will_accept_out_of_the_template() {
        let guard = "{%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}\n\
             {{- raise_exception('Unexpected reasoning effort ') }}";
        assert_eq!(accepted_efforts(guard), ["low", "medium", "xhigh"]);
    }

    #[test]
    fn a_template_with_no_guard_to_read_offers_no_levels() {
        assert_eq!(accepted_efforts("{{- messages }}"), Vec::<String>::new());
    }

    #[test]
    fn a_level_this_build_has_no_word_for_is_not_offered() {
        assert_eq!(
            accepted_efforts("reasoning_effort not in ('low', 'ludicrous')"),
            ["low"]
        );
    }

    #[test]
    fn the_whole_props_carries_the_levels_through() {
        let body = r#"{"model_path":"/models/x.gguf",
            "chat_template":"reasoning_effort not in ('xhigh', 'medium', 'low')",
            "chat_template_caps":{"supports_reasoning_effort":true}}"#;
        let served = parse_props(body).expect("a llama.cpp body is an answer");
        assert_eq!(served.efforts, ["low", "medium", "xhigh"]);
    }

    #[test]
    fn a_server_that_reports_no_modalities_is_not_told_to_drop_images() {
        let served = parse_props(
            r#"{"model_path":"/models/x.gguf","chat_template_caps":{"supports_reasoning_effort":true}}"#,
        )
        .expect("a llama.cpp body is an answer");
        assert_eq!(served.input, None);
        assert_eq!(served.context_window, None);
    }

    #[test]
    fn a_props_without_template_caps_is_some_other_server() {
        assert_eq!(parse_props(r#"{"model_path":"/models/x.gguf"}"#), None);
    }

    #[test]
    fn a_body_that_is_not_json_is_no_answer() {
        assert_eq!(parse_props("<html>404</html>"), None);
    }
}

/// The socket half of the probe, against a listener that answers the way a real host does.
///
/// Separate from the parsing tests above because these cost real milliseconds and bind real ports.
#[cfg(test)]
mod socket_tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::net::TcpListener;
    use std::sync::mpsc;
    use std::thread;

    /// A listener that answers every request with `response` and then does what `close` says.
    ///
    /// Returns the authority it is listening on. The thread lives as long as the test does; it is
    /// detached rather than joined because a test that fails should fail on its assertion.
    fn serve(response: &'static str, close: bool) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("a port");
        let authority = listener.local_addr().expect("an address").to_string();
        let (ready, waited) = mpsc::channel();
        thread::spawn(move || {
            ready.send(()).ok();
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let mut reader = BufReader::new(stream.try_clone().expect("a clone"));
                let mut line = String::new();
                // The request head, up to the blank line that ends it.
                while reader.read_line(&mut line).unwrap_or(0) > 0 {
                    if line.ends_with("\r\n\r\n") || line == "\r\n" {
                        break;
                    }
                }
                stream.write_all(response.as_bytes()).ok();
                stream.flush().ok();
                if close {
                    drop(stream);
                } else {
                    // Held open, the way a keep-alive proxy holds it: the body is complete and the
                    // socket never reaches EOF.
                    thread::sleep(Duration::from_secs(5));
                }
            }
        });
        waited.recv().expect("the listener to start");
        authority
    }

    fn props_response(close: bool) -> String {
        let body = r#"{"model_path":"/models/Qwen3.6-27B.gguf","chat_template_caps":{"supports_preserve_reasoning":true,"supports_reasoning_effort":false},"modalities":{"vision":false,"audio":false},"default_generation_settings":{"n_ctx":120064}}"#;
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{}\r\n{body}",
            body.len(),
            if close {
                "Connection: close\r\n"
            } else {
                "Connection: keep-alive\r\n"
            }
        )
    }

    /// The baseline: a host that closes the socket, which is what llama.cpp itself does.
    #[test]
    fn reads_a_body_from_a_host_that_closes_the_socket() {
        let response: &'static str = Box::leak(props_response(true).into_boxed_str());
        let authority = serve(response, true);
        let text = get(&authority, "/props").expect("a body");
        assert!(text.contains("Qwen3.6-27B.gguf"), "got {text}");
    }

    /**
    A body that arrived in full is an answer, whether or not the socket then closes.

    The read loop only ever stopped at EOF. A peer that honours keep-alive despite being asked to
    close — a reverse proxy, a TLS sidecar, an older cpp-httplib — leaves the socket open, the next
    read blocks until the timeout, the error throws away the complete body already in hand, and the
    whole feature silently reports "not a llama.cpp host".
    */
    #[test]
    fn reads_a_body_from_a_host_that_keeps_the_socket_open() {
        let response: &'static str = Box::leak(props_response(false).into_boxed_str());
        let authority = serve(response, false);
        let started = Instant::now();
        let text = get(&authority, "/props").expect("a body from a keep-alive host");
        assert!(text.contains("Qwen3.6-27B.gguf"), "got {text}");
        // And it did not sit out the timeout to get it: the length said where the body ended.
        assert!(
            started.elapsed() < PROBE_TIMEOUT,
            "waited {:?}",
            started.elapsed()
        );
    }

    /// A body with no length from a host that keeps the socket open is still all there is.
    #[test]
    fn keeps_what_it_read_when_a_lengthless_body_times_out() {
        let body = r#"{"model_path":"/models/x.gguf","chat_template_caps":{"supports_preserve_reasoning":true,"supports_reasoning_effort":false}}"#;
        let response: &'static str = Box::leak(
            format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{body}")
                .into_boxed_str(),
        );
        let authority = serve(response, false);
        let text = get(&authority, "/props").expect("what was read before the timeout");
        assert!(text.contains("x.gguf"), "got {text}");
    }

    /// A non-200 is still not an answer, however it is framed.
    #[test]
    fn a_404_is_no_answer_even_over_keep_alive() {
        let response: &'static str = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n";
        let authority = serve(response, false);
        assert_eq!(get(&authority, "/props"), None);
    }
}
