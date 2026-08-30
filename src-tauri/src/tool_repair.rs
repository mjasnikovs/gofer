//! What a model wrote, held to the shape the protocol takes — and rewritten into it where the
//! order is not a guess.
//!
//! Two halves of one job, and they are here together because they share the table they read.
//! [`repair_set`] runs first and rewrites what it recognises; [`check_set`] runs second and refuses
//! by name whatever is left. Both walk the same [`Param`] list, both recurse into the same nested
//! `entry` shapes, and both decide what a [`Kind`] will accept — so splitting them apart would put
//! that arithmetic in two modules rather than one.
//!
//! This was the second half of `tool_params`, under the generated table. It is a third of that
//! file, ten of its last sixteen commits, and it shares nothing with the table but the row it is
//! handed: the table says what an operation *is*, and this says what a call to one has to survive.
//! [`Operation::repair`] and [`Operation::check`] are still the way in, so no caller moved.
//!
//! The order inside [`repair_set`] is load-bearing and stated where it runs. What is left to the
//! worker's `prepareArguments` — the `ops` bracket, the wrapper the parameters were parked under,
//! the whitespace round a parameter's *name* — is what the generated schema refuses before the
//! router is reached, and only that. Everything about what a value or a key *means* is here.

use crate::ai_tools::ToolFailure;
#[cfg(test)]
use crate::tool_params::operation_of;
use crate::tool_params::{Kind, Param, signature};
use serde_json::{Value, json};

/// `timeoutMs` is lifted out of the parameters by the router for every command, so it is accepted
/// everywhere rather than repeated in forty tables.
///
/// `op` is not here. It names the entry rather than parameterising it, and the router takes it out
/// of the entry before anything — this check, the policy, the approval, the addon — sees one.
const UNIVERSAL: &[&str] = &["timeoutMs"];

/// [`Operation::check`], for a caller holding two strings — the drift checks, and the tests that
/// state the pair they are about. The router resolves the operation once and asks the row, which
/// is why this door is read only by tests.
#[cfg(test)]
pub fn check(domain: &str, op: &str, params: &Value) -> Result<(), ToolFailure> {
    operation_of(domain, op).map_or(Ok(()), |operation| operation.check(params))
}

/// One object against one parameter list, at `where_` — the empty string for the call's own
/// parameters, `files[0]` or `files[0].edits[1]` for something inside one of them.
///
/// The wording is the whole point of the nesting. `missing field oldText` is what serde says about
/// the same call, and a model cannot act on it: it names no operation, no parameter and no
/// position. `godot_script edit \`files[0].edits[1]\` requires \`oldText\`` names all three.
pub(crate) fn check_set(
    call: &str,
    op: &str,
    where_: &str,
    spec: &[Param],
    object: &serde_json::Map<String, Value>,
) -> Result<(), ToolFailure> {
    let shape = signature(spec);
    let (at, noun, takes) = if where_.is_empty() {
        (String::new(), "parameter", "It takes")
    } else {
        (format!(" `{where_}`"), "key", "Each entry takes")
    };
    let takes_shape = if shape.is_empty() {
        format!("{takes} no parameters.")
    } else {
        format!("{takes} {shape}.")
    };

    let unknown: Vec<&String> = object
        .keys()
        .filter(|key| {
            !spec.iter().any(|param| param.name == *key)
                && !(where_.is_empty() && UNIVERSAL.contains(&key.as_str()))
        })
        .collect();
    let single_tear = unknown.iter().any(|key| {
        tore_away_the_value(key, object.get(*key))
            && spec
                .iter()
                .any(|param| !param.hidden && param.name == the_name_at_the_head(key))
    });
    if !single_tear && unknown.len() > 1 && unknown.iter().any(|key| !could_be_a_name(key)) {
        let intact: serde_json::Map<String, Value> = object
            .iter()
            .filter(|(name, _)| spec.iter().any(|param| param.name == name.as_str()))
            .map(|(name, held)| (name.clone(), held.clone()))
            .collect();
        let named = unknown.first().expect("more than one");
        return Err(failure(
            "torn_param",
            format!(
                "{call}{at} has {} keys it does not take, and the object you wrote came apart \
                 across them, so none of them is a word you chose wrongly. {takes_shape}{} An \
                 answer cut off part-way through writing a call arrives exactly like this. Write \
                 it again with fewer operations in it, so the whole call fits in one answer.",
                unknown.len(),
                what_it_carries(&intact)
            ),
            json!({"op": op, "param": path(where_, named), "takes": shape}),
        ));
    }

    for key in object.keys() {
        if spec.iter().any(|param| param.name == key)
            || (where_.is_empty() && UNIVERSAL.contains(&key.as_str()))
        {
            continue;
        }
        if tore_away_the_value(key, object.get(key))
            && let Some(head) = spec
                .iter()
                .find(|param| !param.hidden && param.name == the_name_at_the_head(key))
        {
            let intact: serde_json::Map<String, Value> = object
                .iter()
                .filter(|(name, _)| could_be_a_name(name))
                .map(|(name, held)| (name.clone(), held.clone()))
                .collect();
            let missing = spec
                .iter()
                .find(|param| param.required && !object.contains_key(param.name));
            let (opening, named) = match missing {
                Some(param) => (format!("{call}{at} requires `{}`.", param.name), param),
                None => (
                    format!(
                        "{call}{at} lost `{}` to a torn key, and it is optional here.",
                        head.name
                    ),
                    head,
                ),
            };
            return Err(failure(
                if missing.is_some() {
                    "missing_param"
                } else {
                    "torn_param"
                },
                join(
                    format!(
                        "{opening} {takes_shape}{} One key arrived torn, carrying no value, so \
                         what went wrong is the object you wrote rather than a word you chose: \
                         write the whole call again.",
                        what_it_carries(&intact)
                    ),
                    named.note,
                ),
                json!({"op": op, "param": path(where_, named.name), "takes": shape}),
            ));
        }
        if let Some(swallowed) = the_start_of_another_operation(key) {
            return Err(failure(
                "torn_param",
                format!(
                    "{call}{at} has no `{}` {noun}, and that key carries {swallowed} — so the \
                     list came apart between two entries rather than a word being wrong. \
                     {takes_shape} Write the call again, one entry per operation. If the answer \
                     that wrote it was cut off, send fewer entries in it.",
                    as_much_of_the_key_as_is_evidence(key)
                ),
                json!({"op": op, "param": path(where_, key), "takes": shape}),
            ));
        }
        let hint = where_
            .is_empty()
            .then(|| the_operation_these_keys_belong_to(call, spec, object))
            .flatten()
            .map(|named| {
                format!(
                    " What this entry names is {named}'s parameter list exactly, so it is that \
                     operation rather than a word chosen wrongly here — write it as {named} and \
                     leave this one out."
                )
            })
            .or_else(|| {
                (where_.is_empty() && an_operation_of_this_tool(call, key)).then(|| {
                    format!(
                        " `{key}` is an operation of this tool rather than a parameter of this one, \
                         and a call carries a list of them — ask for it as its own entry beside \
                         this one."
                    )
                })
            })
            .or_else(|| nearest(key, spec).map(|name| format!(" Did you mean `{name}`?")))
            .unwrap_or_default();
        return Err(failure(
            "unknown_param",
            format!(
                "{call}{at} has no `{}` {noun}. {takes_shape}{hint}{}",
                as_much_of_the_key_as_is_evidence(key),
                torn_object(key, object.get(key))
            ),
            json!({"op": op, "param": path(where_, key), "takes": shape}),
        ));
    }

    for param in spec {
        match object.get(param.name) {
            None if param.required => {
                return Err(failure(
                    "missing_param",
                    join(
                        format!(
                            "{call}{at} requires `{}`. {takes_shape}{}",
                            param.name,
                            what_it_carries(object)
                        ),
                        param.note,
                    ),
                    json!({"op": op, "param": path(where_, param.name), "takes": shape}),
                ));
            }
            None => {}
            Some(value) => check_one(call, op, where_, param, value)?,
        }
    }
    Ok(())
}

/// The head of a key, which is where the evidence is. A torn key can be arbitrarily long.
///
/// The same reasoning [`torn_object`] applies to the value: the shape is the evidence, not the
/// length of it. And it matters more here, because what makes a key long is the wreckage. One live
/// turn sent `size=[32, 64]}]'</parameter>]</parameter>></function></tool_call></parameter>   Let
/// me fix the syntax. <tool_call>1;0;0}{` — its own harness's closing tags, in its own JSON — three
/// times running, and the refusal read every one of them back into the conversation. The head says
/// what tore; the tail is the thing not to repeat.
/// Whether a key names another operation of the tool this call is for.
///
/// `godot_runtime input` was sent `{"events": […], "capture": true}` in two runs. `capture` is not
/// a parameter of `input` and never will be — it is the operation next to it, and a call carries a
/// list of operations, so the caller can simply ask for both. The refusal listed `input`'s
/// parameters and left the word it had actually written unexplained.
///
/// The tool is read off the call's own name, which `check_set` is given as "godot_runtime input".
fn an_operation_of_this_tool(call: &str, key: &str) -> bool {
    let Some((tool, op)) = call.split_once(' ') else {
        return false;
    };
    crate::ai_tools::CATALOG
        .iter()
        .filter(|domain| domain.name == tool)
        .any(|domain| {
            domain
                .operations
                .iter()
                .any(|operation| operation.op == key && operation.op != op)
        })
}

/// The one operation in the catalogue whose parameter list these keys are, when there is one.
///
/// A wrong key is usually a wrong word. Sometimes the whole operation is in the wrong place, and
/// then no wording about the key can help. `loc-12-mainscene` wrote eight operations to
/// `godot_scene`, seven of them node creations:
///
/// ```text
/// {"op": "create", "parent": "/Platformer", "name": "Floor", "type": "StaticBody2D"}
///   -> godot_scene create has no `parent` parameter. It takes {path, rootType, rootName?}.
///      None of the 8 operations in this call ran. … send all 8 again with this one corrected.
/// ```
///
/// It sent all eight again, byte for byte, and was refused again. There is no correction to that
/// entry that makes it work: `{parent, name, type}` is `godot_node create`, and the sentence asked
/// for something that does not exist.
///
/// So the keys are matched against every operation in the catalogue, both ways — every required
/// parameter present, nothing held that the operation does not declare — and named only when
/// exactly one fits. `{"path": …}` alone fits eleven operations and says nothing; `{parent, name,
/// type}` fits one.
fn the_operation_these_keys_belong_to(
    call: &str,
    spec: &[Param],
    object: &serde_json::Map<String, Value>,
) -> Option<String> {
    let supplied: Vec<&str> = spec
        .iter()
        .filter(|param| param.hidden)
        .map(|param| param.name)
        .collect();
    let written: Vec<&str> = object
        .keys()
        .map(String::as_str)
        .filter(|key| *key != "op" && !UNIVERSAL.contains(key) && !supplied.contains(key))
        .collect();
    if written.is_empty() {
        return None;
    }
    let fitting: Vec<String> = crate::ai_tools::CATALOG
        .iter()
        .flat_map(|domain| {
            domain.operations.iter().filter_map(|operation| {
                let named = format!("{} {}", domain.name, operation.op);
                let visible = || operation.params.iter().filter(|param| !param.hidden);
                let holds_all = visible()
                    .filter(|param| param.required)
                    .all(|param| written.contains(&param.name));
                let nothing_extra = written
                    .iter()
                    .all(|key| operation.params.iter().any(|param| param.name == *key));
                (holds_all && nothing_extra).then_some(named)
            })
        })
        .collect();
    if fitting.iter().any(|named| named == call) {
        return None;
    }
    let [only] = fitting.as_slice() else {
        return None;
    };
    Some(only.clone())
}

fn as_much_of_the_key_as_is_evidence(key: &str) -> String {
    const LONGEST: usize = 40;
    if key.chars().count() <= LONGEST {
        return key.to_owned();
    }
    format!("{}…", key.chars().take(LONGEST).collect::<String>())
}

/// The keys an object did arrive with, so a missing one is a difference rather than an absence.
///
/// `godot_script edit \`files[0]\` requires \`path\`` is the second commonest refusal in the recorded
/// live turns and the only frequent one that says nothing about what was sent — an `unknown_param`
/// carries the value that arrived, and this carried the shape that was wanted and no more. Three
/// separate turns hit it, in three separate sessions, and none of the traces can say what shape
/// they wrote, because nothing anywhere recorded it.
///
/// The names alone, never the values: an edit's `oldText` is a whole function, and a refusal is not
/// where to put one back.
fn what_it_carries(object: &serde_json::Map<String, Value>) -> String {
    if object.is_empty() {
        return " This one is empty.".to_owned();
    }
    const SHOWN: usize = 8;
    const LONGEST: usize = 40;
    let named: Vec<String> = object
        .keys()
        .take(SHOWN)
        .map(|key| {
            if key.chars().count() <= LONGEST {
                key.clone()
            } else {
                format!("{}…", key.chars().take(LONGEST).collect::<String>())
            }
        })
        .collect();
    let rest = object.len().saturating_sub(named.len());
    let more = if rest == 0 {
        String::new()
    } else {
        format!(" and {rest} more")
    };
    format!(" This one carries {}{more}.", named.join(", "))
}

/// Where a parameter sits, written the way the model wrote it: `files[0].edits[1].oldText`.
fn path(where_: &str, name: &str) -> String {
    if where_.is_empty() {
        name.to_owned()
    } else {
        format!("{where_}.{name}")
    }
}

/// Whether a value is of a kind. Shape only: nothing here needs the editor or the filesystem.
fn fits(kind: Kind, value: &Value) -> bool {
    match kind {
        Kind::Text => value.is_string(),
        Kind::Int => value.is_i64() || value.is_u64(),
        Kind::Number => value.is_number(),
        Kind::Flag => value.is_boolean(),
        Kind::List => value.is_array(),
        Kind::Object => value.is_object(),
        Kind::Hash => value.as_str().is_some_and(is_hash),
        Kind::Choice(allowed) => value.as_str().is_some_and(|text| allowed.contains(&text)),
        Kind::Either(kinds) => kinds.iter().any(|one| fits(*one, value)),
        Kind::Tagged => value.is_object(),
        Kind::ListOf(_) => value.is_array(),
    }
}

/// Sixty-four lowercase hex characters, and nothing else. A read answers with exactly this.
fn is_hash(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn wanted(kind: Kind) -> String {
    match kind {
        Kind::Text => "a string".to_owned(),
        Kind::Int => "a whole number".to_owned(),
        Kind::Number => "a number".to_owned(),
        Kind::Flag => "true or false".to_owned(),
        Kind::List => "an array".to_owned(),
        Kind::Object => "an object".to_owned(),
        Kind::Hash => "a hash: sixty-four lowercase hex characters".to_owned(),
        Kind::Choice(allowed) => format!("one of {}", allowed.join(", ")),
        Kind::Either(kinds) => {
            let names: Vec<String> = kinds.iter().map(|one| wanted(*one)).collect();
            names.join(" or ")
        }
        Kind::Tagged => "a tagged value".to_owned(),
        Kind::ListOf(inner) => format!("a list of {}", wanted(*inner)),
    }
}

fn check_one(
    call: &str,
    op: &str,
    where_: &str,
    param: &Param,
    value: &Value,
) -> Result<(), ToolFailure> {
    let here = path(where_, param.name);
    if let Kind::Tagged = param.kind {
        return check_tagged(call, &here, param, value);
    }
    if fits(param.kind, value) {
        return check_inside(call, op, &here, param, value);
    }
    let expected = wanted(param.kind);
    let counted = match (param.kind, value.as_str()) {
        (Kind::Hash, Some(text)) => format!(
            " That is {} character{}, so it is a copy that slipped rather than a hash of anything. \
             Copy it again from the read that answered with it.",
            text.chars().count(),
            if text.chars().count() == 1 { "" } else { "s" }
        ),
        _ => String::new(),
    };
    Err(failure(
        "invalid_param",
        join(
            format!(
                "{call} `{here}` takes {expected}, and this one was {}.{counted}",
                describe(value)
            ),
            param.note,
        ),
        json!({"param": here, "received": value}),
    ))
}

/// What is inside a `list` or an `object`, when the parameter says what that is.
///
/// A list is checked entry by entry, so the position is in the answer: the model that nested five
/// files inside each other's `edits` was told `missing field oldText` and could not tell which of
/// the five, or that nesting was the mistake at all.
fn check_inside(
    call: &str,
    op: &str,
    here: &str,
    param: &Param,
    value: &Value,
) -> Result<(), ToolFailure> {
    if let Kind::ListOf(inner) = param.kind {
        for (index, item) in value.as_array().into_iter().flatten().enumerate() {
            if !fits(*inner, item) {
                return Err(failure(
                    "invalid_param",
                    join(
                        format!(
                            "{call} `{here}[{index}]` takes {}, and this one was {}.",
                            wanted(*inner),
                            describe(item)
                        ),
                        param.note,
                    ),
                    json!({"param": format!("{here}[{index}]"), "received": item}),
                ));
            }
        }
        return Ok(());
    }
    if param.entry.is_empty() {
        return Ok(());
    }
    let mut entries: Vec<(String, &Value)> = Vec::new();
    match value.as_array() {
        Some(items) => {
            for (index, item) in items.iter().enumerate() {
                entries.push((format!("{here}[{index}]"), item));
            }
        }
        None => entries.push((here.to_owned(), value)),
    }
    for (at, item) in entries {
        let Some(object) = item.as_object() else {
            return Err(failure(
                "invalid_param",
                join(
                    format!(
                        "{call} `{at}` takes an object of {}, and this one was {}.",
                        signature(param.entry),
                        describe(item)
                    ),
                    param.note,
                ),
                json!({"param": at, "received": item}),
            ));
        };
        check_set(call, op, &at, param.entry, object)?;
    }
    Ok(())
}

/// Every tag the protocol carries, and the payload it requires.
///
/// This is the same table `Protocol.decode` walks in the addon, and it stays the addon's job too:
/// that one is the wire's own backstop and cannot be removed. What it cannot be is the *first*
/// place a shape is examined, because by then the call has crossed a socket and the answer has been
/// flattened to `code: message`.
const TAGS: &[(&str, Payload)] = &[
    ("null", Payload::Anything),
    ("bool", Payload::Boolean),
    ("int", Payload::Numeric),
    ("float", Payload::Numeric),
    ("string", Payload::Str),
    ("vector2", Payload::Numbers(2)),
    ("vector2i", Payload::Numbers(2)),
    ("vector3", Payload::Numbers(3)),
    ("vector3i", Payload::Numbers(3)),
    ("vector4", Payload::Numbers(4)),
    ("vector4i", Payload::Numbers(4)),
    ("quaternion", Payload::Numbers(4)),
    ("color", Payload::Colour),
    ("rect2", Payload::Numbers(4)),
    ("rect2i", Payload::Numbers(4)),
    ("plane", Payload::Numbers(4)),
    ("transform2d", Payload::Numbers(6)),
    ("basis", Payload::Numbers(9)),
    ("transform3d", Payload::Numbers(12)),
    ("array", Payload::Items),
    ("dictionary", Payload::Pairs),
    ("resource", Payload::ResourcePath),
];

#[derive(Clone, Copy, PartialEq)]
enum Payload {
    Anything,
    /// Four numbers, or a name or hex string the engine reads as one. `Color.from_string` takes
    /// "skyblue" and "#8b5a2b" alike, `resource.create_texture` takes them, and a `color` value
    /// that refused them was the one place in the tool where a colour had to be spelled another
    /// way — one live turn wrote "red" here and was told a colour is four numbers.
    Colour,
    Boolean,
    Numeric,
    Str,
    Numbers(usize),
    Items,
    Pairs,
    ResourcePath,
}

/// How many numbers a payload is written as, where it is written as numbers at all.
///
/// A colour is four of them and also a name, so the repairs that put `{r, g, b, a}` back into an
/// array have to know both — the shape is the same however the value may also be spelled.
fn how_many_numbers(payload: &Payload) -> Option<usize> {
    match payload {
        Payload::Numbers(count) => Some(*count),
        Payload::Colour => Some(4),
        _ => None,
    }
}

fn check_tagged(call: &str, here: &str, param: &Param, value: &Value) -> Result<(), ToolFailure> {
    let example = "{\"type\": \"vector2\", \"value\": [12, 34]}";
    let Some(object) = value.as_object() else {
        return Err(failure(
            "invalid_param",
            join(
                format!(
                    "{call} `{here}` takes a tagged value like {example}, and this one was {}.",
                    describe(value)
                ),
                param.note,
            ),
            json!({"param": here, "received": value}),
        ));
    };
    let Some(tag) = object.get("type").and_then(Value::as_str) else {
        return Err(failure(
            "invalid_param",
            join(
                format!("{call} `{here}` needs a `type`, as in {example}."),
                param.note,
            ),
            json!({"param": here, "received": value}),
        ));
    };
    let Some((_, payload)) = TAGS.iter().find(|(name, _)| *name == tag) else {
        let names: Vec<&str> = TAGS.iter().map(|(name, _)| *name).collect();
        return Err(failure(
            "invalid_param",
            format!(
                "{call} `{here}`: `{tag}` is not a value type. They are {}.",
                names.join(", ")
            ),
            json!({"param": here, "type": tag, "types": names}),
        ));
    };
    let inner = object.get("value").unwrap_or(&Value::Null);
    let wrong = match payload {
        Payload::Anything => None,
        Payload::Boolean => (!inner.is_boolean()).then(|| "true or false".to_owned()),
        Payload::Numeric => (!inner.is_number()).then(|| "a number".to_owned()),
        Payload::Str => (!inner.is_string()).then(|| "a string".to_owned()),
        Payload::Numbers(count) => {
            let numbers = inner
                .as_array()
                .is_some_and(|items| items.len() == *count && items.iter().all(Value::is_number));
            (!numbers).then(|| format!("an array of {count} numbers"))
        }
        Payload::Colour => {
            let four = inner
                .as_array()
                .is_some_and(|items| items.len() == 4 && items.iter().all(Value::is_number));
            let named = inner.as_str().is_some_and(|text| !text.trim().is_empty());
            (!four && !named).then(|| {
                "four numbers, or a name like skyblue, or a hex string like #8b5a2b".to_owned()
            })
        }
        Payload::Items => (!inner.is_array()).then(|| "an array of tagged values".to_owned()),
        Payload::Pairs => {
            (!inner.is_array()).then(|| "an array of {key, value} tagged pairs".to_owned())
        }
        Payload::ResourcePath => {
            let held = inner.as_object().and_then(|object| object.get("path"));
            match held.and_then(Value::as_str) {
                Some(path) if !path.trim().is_empty() => None,
                Some(_) => Some("a path, and this one's is empty".to_owned()),
                None if held.is_some() => Some("a path written as a string".to_owned()),
                None => Some("an object carrying a path".to_owned()),
            }
        }
    };
    let Some(expected) = wrong else {
        return Ok(());
    };

    let fix = match payload {
        Payload::ResourcePath => {
            let path = inner.as_str().unwrap_or("res://…");
            format!(" Send {{\"type\": \"resource\", \"value\": {{\"path\": \"{path}\"}}}}.")
        }
        Payload::Numbers(_) | Payload::Colour => how_many_numbers(payload)
            .and_then(|count| numbers_under_names(inner, count))
            .map_or_else(String::new, |numbers| {
                let written: Vec<String> = numbers.iter().map(ToString::to_string).collect();
                format!(
                    " Send {{\"type\": \"{tag}\", \"value\": [{}]}}.",
                    written.join(", ")
                )
            }),
        _ => String::new(),
    };
    Err(failure(
        "invalid_param",
        join(
            format!(
                "{call} `{here}`: a {tag} value takes {expected}{}.{fix}",
                if expected.starts_with("a path") {
                    String::new()
                } else {
                    format!(", and this one was {}", describe(inner))
                }
            ),
            param.note,
        ),
        json!({"param": here, "type": tag, "received": inner}),
    ))
}

/// Every repair a call gets, in the one place production reaches.
///
/// This used to be two functions: a `#[cfg(test)]` wrapper that held the misplaced-call guard, and
/// `repair_set` underneath it, which is what `Operation::repair` actually calls. The guard was
/// therefore **dead in the app** — every test that pinned it went through the wrapper, and a live
/// `godot_scene create` sent `{parent, name, type}` had `name` renamed to `rootName` and `type` to
/// `rootType` before `check` ever saw it, exactly as it did before the guard was written. Found in
/// review, after two entries of this log had called it verified.
///
/// A call written to the wrong operation is left exactly as it was written. Every repair below
/// reads one key at a time, and a key set that belongs to another operation reads as several small
/// mistakes rather than as one big one — so the keys the caller wrote are the keys the refusal
/// names, and `the_operation_these_keys_belong_to` can say where they belong.
///
/// One rename runs before the question is asked, because it changes the answer to it.
/// `{"node": …, "properties": […]}` is `godot_runtime inspect_node` written with `godot_node`'s
/// word for a node, and it is also `godot_node inspect`'s parameter list exactly — so the guard
/// alone would call it a misplaced call and leave it. The catalogue disagrees: `inspect_node`'s
/// `path` says in its own note that this is the same thing `godot_node` calls `node`. A synonym the
/// surface declares outranks a shape that merely fits, so it is applied first and the guard then
/// sees the call the caller meant.
pub(crate) fn repair_call(tool: &str, op: &str, spec: &'static [Param], params: &mut Value) {
    if let Some(object) = params.as_object_mut() {
        the_word_the_operation_does_not_use(spec, object);
    }
    if params
        .as_object()
        .and_then(|object| {
            the_operation_these_keys_belong_to(&format!("{tool} {op}"), spec, object)
        })
        .is_some()
    {
        return;
    }
    repair_set(spec, params);
}

/// [`repair_call`], for a caller holding two strings. Read only by tests, like the lookup behind it.
#[cfg(test)]
pub fn repair(domain: &str, op: &str, params: &mut Value) {
    if let Some(operation) = operation_of(domain, op) {
        repair_call(domain, op, operation.params, params);
    }
}

pub(crate) fn repair_set(spec: &[Param], params: &mut Value) {
    let Some(object) = params.as_object_mut() else {
        return;
    };
    put_the_pair_back(spec, object);
    drop_the_wreckage_of_a_pair_that_survived(spec, object);
    fold_a_tag_written_flat(spec, object);
    a_pair_written_as_one_key(spec, object);
    drop_the_empty_claimant(spec, object);
    drop_the_wreckage_a_complete_call_can_spare(spec, object);
    rename_a_list_written_under_another_name(spec, object);
    drop_a_value_the_call_already_carries(spec, object);
    a_number_written_onto_its_own_name(spec, object);
    the_word_the_operation_does_not_use(spec, object);
    fold_a_lone_entry_into_the_list_it_belongs_to(spec, object);
    let wanted: Vec<(String, &'static str)> = object
        .keys()
        .filter(|key| {
            !spec.iter().any(|param| param.name == key.as_str())
                && !UNIVERSAL.contains(&key.as_str())
        })
        .filter_map(|key| {
            only_one_meaning(key, object.get(key), spec).map(|name| (key.clone(), name))
        })
        .filter(|(_, name)| !object.contains_key(*name))
        .collect();
    let mut rename: Vec<(String, &'static str)> = Vec::new();
    let mut spare: Vec<String> = Vec::new();
    for (wrong, right) in &wanted {
        let contenders: Vec<&String> = wanted
            .iter()
            .filter(|(_, name)| name == right)
            .map(|(key, _)| key)
            .collect();
        let first = contenders[0];
        if contenders.len() == 1 {
            rename.push((wrong.clone(), *right));
        } else if !contenders
            .iter()
            .all(|key| object.get(key.as_str()) == object.get(first.as_str()))
        {
            continue;
        } else if first == wrong {
            rename.push((wrong.clone(), *right));
        } else {
            spare.push(wrong.clone());
        }
    }
    for wrong in spare {
        object.remove(&wrong);
    }
    for (wrong, right) in rename {
        if let Some(held) = object.remove(&wrong) {
            object.insert(right.to_owned(), held);
        }
    }
    for param in spec {
        let Some(held) = object.get_mut(param.name) else {
            continue;
        };
        trim_a_name(param, held);
        unbox_the_one(param.kind, held);
        match param.kind {
            Kind::Tagged => repair_tagged(held),
            Kind::List if !param.entry.is_empty() => {
                if let Some(items) = held.as_array_mut() {
                    for item in items {
                        repair_set(param.entry, item);
                    }
                }
            }
            Kind::Object if !param.entry.is_empty() => repair_set(param.entry, held),
            _ => {}
        }
    }
}

/// A name and its value written as one key, with the colon and the quotes lost between them.
///
/// One live turn's `create_shape` calls, six of them in a row, five distinct shapes:
///
/// ```text
/// {"op": "create_shape", "path": …, "shapeType": "RectangleShape2D", "size [16, 16]": null}
/// {"op": "create_shape", "op create_shape": null, "path shapes/floor_shape.tres": null,
///  "shapeType RectangleShape2D": null, "size [640, 16]": null}
/// ```
///
/// Every one of them is `"<name> <value>": null`. The pair was written, the separator was not, and
/// what should have been a value became part of the key — so the parameter is absent and the key
/// beside it names nothing. Neither existing repair reaches it: the key is not name-shaped, so
/// `only_one_meaning` needs a value beside it and there is none, and it holds more than punctuation
/// past its name, so `tore_away_the_value` says no.
///
/// Two shapes, and nothing else:
///
/// The tail is a whole JSON value — `[16, 16]` — or one plain word with no space, comma, quote or
/// bracket in it, which is what a path, a class name or a node path looks like. A tail that is
/// neither is wreckage rather than a value: `"size 16: null}]er_shape.tres, "` is two calls that
/// ran into each other, and `"path a.tres, b.tres"` is two operations written as one. Both stay for
/// `check` to name.
///
/// And the result has to be one the parameter could hold, which is the rule every rename follows.
///
/// A key whose head names something the object already carries, with the same value, is the second
/// half of a pair that survived — `"op create_shape": null` beside `"op": "create_shape"`. It says
/// nothing the call has not already said, and it is taken away rather than read.
fn a_pair_written_as_one_key(spec: &[Param], object: &mut serde_json::Map<String, Value>) {
    let torn: Vec<String> = object
        .keys()
        .filter(|key| !spec.iter().any(|one| one.name == key.as_str()))
        .cloned()
        .collect();
    for key in torn {
        let head = the_name_at_the_head(&key).to_owned();
        if head.is_empty() {
            continue;
        }
        let tail = key[head.len()..].trim_matches(|one: char| {
            one.is_whitespace() || one == ':' || one == '=' || one == '"' || one == '\''
        });
        if tail.is_empty() {
            continue;
        }
        let beside = object
            .get(&key)
            .filter(|held| carries_a_value(Some(held)))
            .cloned();
        let written = match beside {
            Some(held) if says_the_same(tail, &held) => held,
            Some(_) => continue,
            None => match a_value_out_of(tail) {
                Some(held) => held,
                None => continue,
            },
        };
        if object.get(&head) == Some(&written) {
            object.remove(&key);
            continue;
        }
        if object.contains_key(&head) {
            continue;
        }
        let Some(param) = spec
            .iter()
            .find(|one| !one.hidden && one.name == head.as_str())
        else {
            continue;
        };
        if !could_become(param.kind, &written) {
            continue;
        }
        object.remove(&key);
        object.insert(head, written);
    }
}

/// Whether a torn key's tail is the value beside it, written again.
///
/// `"index 0": 0` and `"name: Coin1": "Coin1"` both say the value twice, once in the key and once
/// where it belongs. That agreement is the evidence: a key that merely *reads* as a name — `pathx`,
/// `size_list` — says nothing twice, and belongs to the rename rather than here.
fn says_the_same(tail: &str, held: &Value) -> bool {
    match held {
        Value::String(text) => tail == text,
        other => serde_json::to_string(other).is_ok_and(|written| tail == written),
    }
}

/// The value half of a key that swallowed one, or nothing when what is there is not a value.
///
/// A whole JSON value, or one plain word. `serde_json` stops at the end of the first value it
/// reads, so the whole tail has to be consumed — otherwise `[32, 32]}]edits`, which is two tool
/// calls that ran into each other, would read as a size.
fn a_value_out_of(tail: &str) -> Option<Value> {
    if let Ok(held) = serde_json::from_str::<Value>(tail) {
        return Some(held);
    }
    let closed = tail
        .trim_end_matches(|one: char| one.is_whitespace() || matches!(one, ',' | '}' | ']' | ')'));
    if closed != tail
        && !closed.is_empty()
        && let Ok(held) = serde_json::from_str::<Value>(closed)
    {
        return Some(held);
    }
    let plain = !tail.chars().any(|one| {
        one.is_whitespace() || matches!(one, ',' | '"' | '\'' | '{' | '}' | '[' | ']' | ':' | '=')
    });
    plain.then(|| Value::String(tail.to_owned()))
}

/// Wreckage over a call that is complete without it, taken away so the call can run.
///
/// Measured, on a live turn building a Breakout board:
///
/// ```text
/// {"op": "instantiate", "parent": "/Main", "path": "res://scenes/brick.tscn",
///  "name': null}]_1_1_PLACEHOLDER_1_1'}, {": null}
/// ```
///
/// `parent` and `path` are both there and both right, and `name` is optional — the entry is a
/// working call with a piece of the model's own wreckage sitting beside it. It was refused, and
/// the same call came back **eight times**: three plain refusals and then five from the repeat
/// guard, which says the call cannot succeed and to build it again. The model could not see the
/// key it had written, so it wrote it again, and the board never got its bricks.
///
/// The rule this replaces was deliberate — "dropping it quietly would build a node under a name
/// nobody asked for" — and it was written without a measurement. Here is one: the caller loses an
/// optional value it never managed to write, against eight round trips and no instance at all.
/// Four more refusals in the same turn were the same shape, `{"op": "edit", "files": […],
/// "op_save": null}` and `"op_note": null`.
///
/// Only when the call is otherwise whole and the wreckage is empty. A key holding *something* is a
/// value the caller wrote and may have meant, and one required parameter missing is a call that
/// cannot run anyway — both keep the refusal that names them.
fn drop_the_wreckage_a_complete_call_can_spare(
    spec: &[Param],
    object: &mut serde_json::Map<String, Value>,
) {
    if spec
        .iter()
        .any(|param| param.required && !object.contains_key(param.name))
    {
        return;
    }
    let unknown: Vec<String> = object
        .keys()
        .filter(|key| {
            !spec.iter().any(|param| param.name == key.as_str())
                && !UNIVERSAL.contains(&key.as_str())
                && !(key.as_str() == "op" && object[key.as_str()].is_string())
        })
        .cloned()
        .collect();
    if unknown.is_empty() || unknown.iter().any(|key| carries_a_value(object.get(key))) {
        return;
    }
    for key in unknown {
        object.remove(&key);
    }
}

/// One entry of a required list, written without the list around it.
///
/// `godot_script edit` takes `files`, a list of `{path, edits}`. A caller changing one file has one
/// entry to write, and two recorded turns wrote just the entry:
///
/// ```text
/// {"op": "edit", "path": "scripts/player.gd", "edits": [{"oldText": …, "newText": …}]}
/// {"op": "edit", "edit": {"path": "scripts/game_state.gd", "edits": [{"oldText": …, "newText": …}]}}
/// ```
///
/// The first spreads the entry across the call; the second puts it under a name of its own. Both
/// carry a complete entry and neither carries the list, and both are refused for a key — `path`,
/// `edit` — that is beside the point: the call says exactly which file and exactly which edits.
///
/// So the entry is put in the list it belongs to, in either shape, and only when there is one
/// reading: one required list parameter absent, an entry spec to match, and every field of that
/// entry present with nothing left over. `exactly_fits` is the same both-ways match
/// `rename_a_list_written_under_another_name` uses, and it is what keeps a call that merely
/// resembles an entry out of this.
fn fold_a_lone_entry_into_the_list_it_belongs_to(
    spec: &[Param],
    object: &mut serde_json::Map<String, Value>,
) {
    let absent: Vec<&Param> = spec
        .iter()
        .filter(|param| param.required && !param.hidden && param.kind == Kind::List)
        .filter(|param| !param.entry.is_empty() && !object.contains_key(param.name))
        .collect();
    let [target] = absent.as_slice() else {
        return;
    };
    let spread: serde_json::Map<String, Value> = object
        .iter()
        .filter(|(key, _)| !UNIVERSAL.contains(&key.as_str()) && key.as_str() != "op")
        .filter(|(key, _)| !spec.iter().any(|param| param.name == key.as_str()))
        .map(|(key, held)| (key.clone(), held.clone()))
        .collect();
    let named: Vec<String> = spread.keys().cloned().collect();
    let entry = if exactly_fits(target.entry, &Value::Object(spread.clone())) {
        Value::Object(spread)
    } else {
        let [only] = named.as_slice() else {
            return;
        };
        let held = object.get(only.as_str()).cloned().unwrap_or(Value::Null);
        if !exactly_fits(target.entry, &held) {
            return;
        }
        held
    };
    for key in named {
        object.remove(&key);
    }
    object.insert(target.name.to_owned(), Value::Array(vec![entry]));
}

/// A number written onto the end of the parameter it belongs to.
///
/// `loc-63-resources` sent `godot_logs read` this, twice, byte for byte:
///
/// ```text
/// {"op": "read", "contains": "AREA", "limit20": true, "sourceeditor": "editor"}
/// ```
///
/// `sourceeditor` is already repaired — it reads as `source` by prefix and `"editor"` is a value
/// `source` can hold. `limit20` is the same tear with the value on the wrong side of the quote: the
/// name is `limit`, the number is in the key, and the `true` beside it is whatever the serialiser
/// put there once it had written a key that needed one. The caller's own third attempt was
/// `{"contains": "AREA", "limit": 20, "source": "editor"}`, which is what this writes.
///
/// It cannot collide with a real name: `no_parameter_is_named_with_a_number_on_the_end` holds the
/// whole catalogue to that, so a key of digits past a parameter's name is always a tear.
///
/// And it never throws a usable value away. The value beside the key has to be one the parameter
/// could not take — `true` for an `int` — because `{"limit20": 5}` is two readings and neither is
/// this rule's to pick.
fn a_number_written_onto_its_own_name(spec: &[Param], object: &mut serde_json::Map<String, Value>) {
    let torn: Vec<(String, &'static str, i64)> = object
        .iter()
        .filter_map(|(key, held)| {
            let digits = key.trim_end_matches(|c: char| c.is_ascii_digit());
            if digits.len() == key.len() || digits.is_empty() {
                return None;
            }
            let number: i64 = key[digits.len()..].parse().ok()?;
            let param = spec
                .iter()
                .find(|param| !param.hidden && param.name == digits)
                .filter(|param| matches!(param.kind, Kind::Int | Kind::Number))
                .filter(|param| !object.contains_key(param.name))
                .filter(|param| !could_become(param.kind, held))?;
            Some((key.clone(), param.name, number))
        })
        .collect();
    for (key, name, number) in torn {
        object.remove(&key);
        object.insert(name.to_owned(), Value::from(number));
    }
}

/// Whether a name appears anywhere inside what a parameter holds, however deep.
///
/// A note is prose, and prose about a list talks about the list's contents. `godot_script edit`'s
/// `files` says "Every `oldText` must match one region of that file exactly" — which reads, to a
/// rule that only looks for backticks, exactly like a declared synonym. Probed: `{"oldText": [...]}`
/// was renamed onto `files` and the call then refused for an entry that was a string. `oldText` is
/// a field two levels down inside `files`, so it is what `files` is made of and never another word
/// for it.
fn a_field_of_its_own(entry: &[Param], name: &str) -> bool {
    entry
        .iter()
        .any(|param| param.name == name || a_field_of_its_own(param.entry, name))
}

/// The one key nothing knows, onto the required parameter whose own note calls it that.
///
/// Every other rename here reads the key: `nodePath` reaches `node` because the letters get there,
/// and `path:` reaches `path` because the colon is the only thing in the way. Some wrong keys are
/// not misspellings at all. They are a different word for the same thing, and no amount of spelling
/// crosses from one to the other:
///
/// ```text
/// {"op": "inspect_node", "node": "/root/Game/Player", "properties": ["global_position"]}
///   -> godot_runtime inspect_node has no `node` parameter. It takes {path: text, properties?: list}
/// ```
///
/// Twelve runs wrote that, every one of them on a model that had just used `node` on the tool next
/// door, where it is the right word. It is the largest single `unknown_param` shape in the
/// recordings.
///
/// **The catalogue is what decides it, not the shape of the call.** `inspect_node`'s `path` carries
/// a note that says "godot_node calls this same thing `node`" — the surface declaring its own
/// synonym, in the sentence the model is already given. So a stray key is renamed only onto a
/// missing required parameter whose note names that key in backticks, and adding a synonym means
/// writing it where a reader can see it.
///
/// A looser rule was built first and measured against the whole corpus. It renamed the one stray
/// key onto the one absent required parameter whenever the value could be one, which recovered
/// thirteen calls — and the thirteenth was wrong:
///
/// ```text
/// {"op": "instantiate", "node": "/Main/Coin", "path": "res://scenes/coin.tscn"}
/// ```
///
/// `node` there is the path of the node about to exist, and the caller's own next call proves it:
/// `{"parent": "/Main", "name": "Coin", "path": …}`. Renaming it onto `parent` writes a call
/// nobody meant and answers it with `/Main/Coin` not found, which is further from the mistake than
/// the refusal it replaced. `instantiate`'s `parent` says nothing about a node, and now that is the
/// reason it is left alone.
///
/// A key the spelling rules can already read is left to them. `only_one_meaning` weighs the value
/// against the parameter it names, and a key that reads as something has said what it means; this
/// rule is for the keys that say nothing, and the two must never answer the same key differently.
fn the_word_the_operation_does_not_use(
    spec: &[Param],
    object: &mut serde_json::Map<String, Value>,
) {
    let strays: Vec<String> = object
        .keys()
        .filter(|key| {
            !spec.iter().any(|param| param.name == key.as_str())
                && !UNIVERSAL.contains(&key.as_str())
                && key.as_str() != "op"
        })
        .cloned()
        .collect();
    let [stray] = strays.as_slice() else {
        return;
    };
    if the_one_it_reads_as(stray, spec).is_some() {
        return;
    }
    let called_that = format!("`{stray}`");
    let absent: Vec<&Param> = spec
        .iter()
        .filter(|param| param.required && !param.hidden && !object.contains_key(param.name))
        .filter(|param| param.note.contains(&called_that))
        .filter(|param| !a_field_of_its_own(param.entry, stray))
        .collect();
    let [target] = absent.as_slice() else {
        return;
    };
    let Some(held) = object.get(stray.as_str()) else {
        return;
    };
    if !could_become(target.kind, held) {
        return;
    }
    let name = target.name;
    let moved = object.remove(stray).unwrap_or(Value::Null);
    object.insert(name.to_owned(), moved);
}

/// The operation's own list, written under a name the operation does not have.
///
/// ```text
/// {"op": "edit", "edits": [{"path": "scripts/player.gd", "edits": [{"oldText": …}]}]}
/// ```
///
/// `edit`'s list is `files`, and every entry the model put under `edits` *is* a `files` entry — a
/// `path` and its own `edits`. The whole call is right except the word above it, and it was
/// answered "godot_script edit has no `edits` parameter. It takes {files: list of {path: text,
/// edits: …}}": a sentence that quotes back the shape the caller had already written and never says
/// the shape is the part that is right. Three recorded live turns, in `N01-backwards`,
/// `V02-backwards` and `s24-level`, each losing a whole batch of edits to the name.
///
/// [`only_one_meaning`] cannot reach it — `edits` is not a near miss for `files`, it is a different
/// word — and [`drop_a_value_the_call_already_carries`] is right not to: there is no `files` here
/// for the key to be a copy of.
///
/// The fit is what makes it a repair rather than a guess, and it is the same "exactly" every other
/// rule in this file uses: every entry under the stray key holds every required field of the
/// declared entry and holds nothing the declared entry does not. Narrow on every side — one stray
/// key of that shape, exactly one declared list it fits, and that list not already written, because
/// a stray beside a list that is already there is a second copy rather than a misspelling and
/// choosing between two copies is not a repair.
/// Moved here from above `fold_a_lone_entry_into_the_list_it_belongs_to`, which was inserted
/// between this paragraph and the function it describes and then kept it. This is the rename;
/// that one is the fold, and they are two different repairs of two different shapes.
fn rename_a_list_written_under_another_name(
    spec: &[Param],
    object: &mut serde_json::Map<String, Value>,
) {
    let strays: Vec<String> = object
        .keys()
        .filter(|key| {
            !spec.iter().any(|param| param.name == key.as_str())
                && !UNIVERSAL.contains(&key.as_str())
                && key.as_str() != "op"
                && object
                    .get(key.as_str())
                    .and_then(Value::as_array)
                    .is_some_and(|held| !held.is_empty() && held.iter().all(Value::is_object))
        })
        .cloned()
        .collect();
    let [stray] = strays.as_slice() else {
        return;
    };
    let Some(held) = object.get(stray).and_then(Value::as_array).cloned() else {
        return;
    };
    let fitting: Vec<&Param> = spec
        .iter()
        .filter(|param| param.kind == Kind::List && !param.entry.is_empty())
        .filter(|param| !object.contains_key(param.name))
        .filter(|param| held.iter().all(|entry| exactly_fits(param.entry, entry)))
        .collect();
    let [target] = fitting.as_slice() else {
        return;
    };
    let name = target.name;
    let moved = object.remove(stray).unwrap_or(Value::Null);
    object.insert(name.to_owned(), moved);
}

/// One object against one declared entry, both ways: every required field held, and nothing held
/// that the entry does not declare. The same "exactly" `check_set` enforces, asked rather than
/// refused.
fn exactly_fits(declared: &[Param], value: &Value) -> bool {
    let Some(object) = value.as_object() else {
        return false;
    };
    declared
        .iter()
        .all(|param| !param.required || object.contains_key(param.name))
        && object
            .keys()
            .all(|key| declared.iter().any(|param| param.name == key.as_str()))
}

/// A key the operation does not take, holding a value the call already carries inside its own list.
///
/// Measured across three live turns, all of them `godot_script edit`:
///
/// ```text
/// {"op": "edit", "files": [{"path": "scripts/player.gd", "edits": […]}],
///  "path": "scripts/player.gd"}
/// ```
///
/// `files` is written correctly and completely. Beside it the model wrote the path a second time,
/// flat, the way `save` takes it — and `edit` has no `path`, so the whole call was refused over a
/// key that says nothing the entry inside `files` had not already said. Three of three carried
/// exactly the path the entry carried.
///
/// [`drop_the_wreckage_a_complete_call_can_spare`] cannot reach it, and is right not to: that rule
/// takes away only a key holding **nothing**, because "a key holding something is a value the
/// caller wrote and may have meant". This is the one case where that reasoning does not apply. The
/// value is not merely present, it is the same value — every entry of the declared list already
/// holds it under the same name — so there is no second meaning to lose.
///
/// Narrow on every side: the call has to be whole without the key, the key's name has to be one the
/// list's own entries declare, the list has to be there, and **every** entry in it has to hold that
/// name with an equal value. A list whose entries name two different files keeps its refusal,
/// because then the flat key really is saying something.
///
/// **The same thing one level flatter**, added after two live turns on `gemma-4-31b` sent
/// `godot_node create` this, identically:
///
/// ```text
/// {"op": "create", "name": "TickTimer", "node": "/ProtocolFixture",
///  "parent": "/ProtocolFixture", "type": "Timer"}
/// ```
///
/// `node` is what `set_property` and `connect_signal` call the node, and `create` calls it
/// `parent` — so the model wrote the value under both names, correctly under one of them. The
/// whole call was refused over a key holding a string the call already held. There is no list here
/// to be a copy of an entry of, so the second clause below is value equality against a **required**
/// parameter that is present: a stray repeating something the call cannot run without is a stray
/// with no second meaning to lose. Anything else keeps its refusal, and the router's own sentence
/// names the parameters the operation does take.
fn drop_a_value_the_call_already_carries(
    spec: &[Param],
    object: &mut serde_json::Map<String, Value>,
) {
    if spec
        .iter()
        .any(|param| param.required && !object.contains_key(param.name))
    {
        return;
    }
    let said_twice: Vec<String> = object
        .keys()
        .filter(|key| {
            !spec.iter().any(|param| param.name == key.as_str())
                && !UNIVERSAL.contains(&key.as_str())
                && key.as_str() != "op"
        })
        .filter(|key| {
            let Some(held) = object.get(key.as_str()) else {
                return false;
            };
            let inside_a_list = spec
                .iter()
                .filter(|param| param.kind == Kind::List && !param.entry.is_empty())
                .filter(|param| param.entry.iter().any(|inner| inner.name == key.as_str()))
                .filter_map(|param| object.get(param.name)?.as_array())
                .any(|entries| {
                    !entries.is_empty()
                        && entries
                            .iter()
                            .all(|entry| entry.get(key.as_str()) == Some(held))
                });
            let beside_a_required_one = spec
                .iter()
                .filter(|param| param.required)
                .any(|param| object.get(param.name) == Some(held));
            inside_a_list || beside_a_required_one
        })
        .cloned()
        .collect();
    for key in said_twice {
        object.remove(&key);
    }
}

/// A key holding nothing, standing between a key holding the answer and the parameter it names.
///
/// `{"path": …, "shapeType": "RectangleShape2D", "size_list": [16, 16], "size_list_note": null}`
/// is what a live turn sent `resource.create_shape`. `size_list` alone is repaired to `size` and
/// the call runs; with the second key beside it both read as `size`, the rename below sees two
/// answers, and it takes neither — a rename nobody can predict being worse than a refusal that
/// names both. So the call was refused, and what blocked it was a key with nothing in it.
///
/// Only that: the key carries no value at all, another unknown key reads as the same parameter and
/// does carry one, and neither is a parameter this operation declares. A key holding something is
/// never dropped, because what it holds is what the caller wrote.
fn drop_the_empty_claimant(spec: &[Param], object: &mut serde_json::Map<String, Value>) {
    let unknown: Vec<(String, bool, Option<&'static str>)> = object
        .iter()
        .filter(|(key, _)| !spec.iter().any(|param| param.name == key.as_str()))
        .filter(|(key, _)| !UNIVERSAL.contains(&key.as_str()))
        .map(|(key, held)| {
            (
                key.clone(),
                carries_a_value(Some(held)),
                the_one_it_reads_as(key, spec),
            )
        })
        .collect();
    let empty: Vec<String> = unknown
        .iter()
        .filter(|(_, carries, reads)| !carries && reads.is_some())
        .filter(|(key, _, reads)| {
            unknown.iter().any(|(other, carries, other_reads)| {
                other != key && *carries && other_reads == reads
            })
        })
        .map(|(key, _, _)| key.clone())
        .collect();
    for key in empty {
        object.remove(&key);
    }
}

/// The two halves of a tagged value, written as two flat keys, folded back to one.
///
/// `{"path": …, "shapeType": "RectangleShape2D", "sizeType": null, "sizeValue": [24, 48]}` is what
/// a live turn sent `resource.create_shape`. `size` is a plain list here and nothing about it is
/// tagged — the model carried the protocol's own `{type, value}` shape over from `set_property`
/// and flattened it onto the parameter name.
///
/// The rename below already turns a lone `sizeValue` into `size`. It cannot turn this one, and
/// deliberately: `sizeType` and `sizeValue` both read as `size`, that is two answers, and
/// `wanted` refuses a contested rename rather than picking whichever the map iterated first. So
/// the call was refused with ``has no `sizeType` parameter … Did you mean `size`?``, which names
/// the half that was already right.
///
/// Measured against the local Qwen3.8-27B at medium, 2 seeds interleaved over two catalogue arms:
/// **0 of 8 `create_shape` entries carried a two-number `size`**, and every one of the eight wrote
/// it under `sizeValue`, `size_value`, `sizeValues` or `sizeType` + `sizeValue`. Printing the
/// shape in the signature — `size?: [width, height]` rather than `size?: list` — changed nothing:
/// 0 of 4 either way. It is the tagged habit, not the word `list`.
///
/// Narrow: the head has to name a declared parameter the object does not already carry, the
/// object has to hold that head's value half as well, and the type half has to hold what a type
/// slot holds — a name, or nothing. No operation in the catalogue declares a `<name>Type` beside
/// a `<name>`, so nothing real is thrown away; `check-command-surface` would have to change for
/// that to stop being true.
fn fold_a_tag_written_flat(spec: &[Param], object: &mut serde_json::Map<String, Value>) {
    const TYPE_HALF: [&str; 2] = ["Type", "_type"];
    const VALUE_HALF: [&str; 4] = ["Value", "Values", "_value", "_values"];
    let flattened: Vec<String> = object
        .iter()
        .filter(|(_, held)| held.is_null() || held.is_string())
        .filter_map(|(key, _)| {
            let head = TYPE_HALF
                .iter()
                .find_map(|suffix| key.strip_suffix(suffix))
                .filter(|head| !head.is_empty())?;
            spec.iter()
                .any(|param| !param.hidden && param.name == head)
                .then_some(())?;
            (!object.contains_key(head)).then_some(())?;
            VALUE_HALF
                .iter()
                .any(|suffix| object.contains_key(&format!("{head}{suffix}")))
                .then(|| key.clone())
        })
        .collect();
    for key in flattened {
        object.remove(&key);
    }
}

/// The parameters whose text is content, where the whitespace round it is part of what was written.
///
/// Everything else a `text` or `choice` parameter carries is a name: a node path, a property, a
/// class, a setting, a group, a signal, a file. None of those has meaningful whitespace at either
/// end, and a model that slips puts it there — the padded *key* has been repaired for a while, and
/// one live turn showed the padded *value* going through untouched twelve times in a row.
///
/// `source` is a whole script buffer, and the trailing newline is the part that mattered: gdformat
/// always ends its output with one, so a trimmed buffer came back differing from what was sent and
/// `godot_script format` answered `changed: true` about a buffer it had not changed.
const TEXT_THAT_IS_CONTENT: [&str; 6] = [
    "text",
    "oldText",
    "newText",
    "originalText",
    "updatedText",
    "source",
];

/// Trims the whitespace round a name, which is never part of one.
///
/// Watched live: `{"parent ": "/Level3D ", "type ": "DirectionalLight3D"}`. The key came back as
/// `parent`, the value stayed `/Level3D `, and the refusal read `Node /Level3D  was not found …
/// the scene's own root is /Level3D` — two strings that look identical on screen. The addon trims
/// node paths now as well; this is the door before it, and it reaches property names, class names,
/// group names and settings paths too.
fn trim_a_name(param: &Param, held: &mut Value) {
    if TEXT_THAT_IS_CONTENT.contains(&param.name) {
        return;
    }
    if !matches!(param.kind, Kind::Text | Kind::Choice(_) | Kind::Hash) {
        return;
    }
    let Some(text) = held.as_str() else {
        return;
    };
    let trimmed = text.trim();
    if trimmed.len() != text.len() {
        *held = Value::String(trimmed.to_owned());
    }
}

/// Takes a lone value out of the list a model wrapped it in.
///
/// The same reasoning as [`sole_entry`], one shape along: a parameter that takes one thing, given a
/// list of exactly one thing of that kind, has been handed the value in a box. There is no order to
/// guess at and nothing to choose between.
///
/// Watched live in one turn building a large project: `godot_node add_to_group \`node\` takes a
/// string, and this one was an array of 1` — four times, and once more for `set_cells`. Every one
/// of them held the single node path the call was about.
///
/// A parameter whose kind already allows a list is left alone: `godot_resource rescan` takes one
/// path or several on purpose, and unwrapping there would change what was asked. So is a list of
/// two, which is a shape rather than a box, and a list of one holding the wrong kind, which is not
/// the value at all. Both stay for the refusal to name.
fn unbox_the_one(kind: Kind, held: &mut Value) {
    if fits(kind, held) || fits(Kind::List, held) && allows_a_list(kind) {
        return;
    }
    let Some(items) = held.as_array() else {
        return;
    };
    let [only] = items.as_slice() else {
        return;
    };
    if !fits(kind, only) {
        return;
    }
    *held = only.clone();
}

/// Whether a kind takes a list itself, and so must never have one unwrapped out from under it.
fn allows_a_list(kind: Kind) -> bool {
    match kind {
        Kind::List => true,
        Kind::Either(kinds) => kinds.iter().any(|one| allows_a_list(*one)),
        _ => false,
    }
}

/// The only value in an object of one entry, or nothing.
///
/// A model that reads `value: tagged` and the kind beside it writes the kind back into the value:
/// `{"type": "float", "value": {"number": 3.5}}` and `{"type": "string", "value": {"text": "…"}}`,
/// eight times in one live turn, under the protocol's own words for those kinds. One entry of the
/// type the tag wants is not a shape with an order to guess at — it is the value, in a box.
///
/// **The key's own name is deliberately ignored, and narrowing this to a list of box words would
/// be worse.** The concern is real on its face: `{"type": "int", "value": {"height": 720}}` written
/// to `viewport_width` is accepted, saved, and reads back 720, so a name that contradicts the
/// parameter is thrown away. Reproduced against a real editor, and then measured for how often a
/// model actually writes one — twenty turns asked to set five properties, counted by
/// `scripts/bench-prompt-line.mjs`:
///
/// 18 boxes were written under a word that is not a box word, and every one of them was a
/// placeholder for the value itself — `{"base": 5}`, `{"n": 5}`, `{"a": true}`, `{"data": 5}`,
/// `{"amount": 5}`, `{"state": true}` — carrying the right number. 15 were written under a box
/// word. Not one named a different property. A box-word list would refuse eighteen correct calls in
/// twenty turns to prevent a shape the model does not write.
///
/// An object of two is still refused, and says what it received, which is where a genuine
/// width-for-height slip lands.
fn sole_entry(value: &Value) -> Option<&Value> {
    let object = value.as_object()?;
    if object.len() != 1 {
        return None;
    }
    object.values().next()
}

/// The protocol's spelling of a tag a model wrote in the engine's.
///
/// `{"type": "String", "value": "Resume"}` is one wrapper written by one model that knew both
/// words: the protocol tag and Godot's own class name. It was refused sixteen times in one live
/// turn — the same call resent unchanged, then split into single properties and resent again — and
/// cost that turn most of its twelve minutes, while the `bool` beside it in the same call went
/// through. Across five recorded turns 41 of 86 tagged values were wrapped twice, and 22 of the 41
/// spelled the inner tag with the engine's capital.
///
/// Every tag the protocol carries is lowercase and no two of them differ only in case, so the fold
/// cannot reach two answers. A word that is not a tag in any case is left exactly as it arrived,
/// so [`check_tagged`] still refuses it in the spelling the caller wrote.
fn fold_the_tag(held: &mut Value) {
    let Some(tag) = held.get("type").and_then(Value::as_str) else {
        return;
    };
    if TAGS.iter().any(|(name, _)| *name == tag) {
        return;
    }
    let lowered = tag.to_lowercase();
    let Some(name) = TAGS
        .iter()
        .find(|(name, _)| *name == lowered)
        .map(|(name, _)| *name)
    else {
        return;
    };
    if let Some(object) = held.as_object_mut() {
        object.insert("type".to_owned(), Value::String(name.to_owned()));
    }
}

/// The tagged value a model wrapped in a second copy of its own tag, unwrapped.
///
/// `{"type": "vector2", "value": {"type": "vector2", "value": [32, 48]}}` is what one live turn
/// against a local Qwen3.6-27B wrote 51 times in 114 tool calls. The router refused every one of
/// them by naming the payload it wanted, and the payload it wanted was inside the value it was
/// handed.
///
/// Only the same tag twice, whatever case each side is written in — the two spellings are the
/// protocol's and the engine's, and [`fold_the_tag`] has already put the outer one back. Two
/// different tags is not a wrapper anybody meant to write, and deciding which of them is the real
/// one is not this layer's to do: the router refuses it and says what it received. A `resource`,
/// whose payload is an object with a `path`, is untouched for the same reason — it is not a tag
/// inside a tag.
///
/// Repeatedly, because three copies is the same mistake as two.
fn unwrap_a_tag_written_twice(held: &mut Value) {
    while let Some((tag, payload)) = a_tag_inside_its_own(held) {
        *held = json!({"type": tag, "value": payload});
    }
}

/// A tagged value whose payload was written beside the tag instead of inside it.
///
/// `t11-platformer` attached a script with this:
///
/// ```text
/// {"path": "res://scripts/player.gd", "type": "resource", "value": null}
/// ```
///
/// Everything the call needs is there — the tag says `resource`, the path says which one — and the
/// one slot that had to hold it is empty. What came back was "a resource value takes an object
/// carrying a path, and this one was null", which describes the shape and not the mistake.
///
/// The payload goes back in its slot when there is nothing else it could be: a tag that is a name,
/// a `value` that is null or absent, and at least one other key to move. A tagged value declares
/// exactly two keys, so anything else beside them arrived by being written one level too high.
fn put_the_payload_back_in_its_slot(held: &mut Value) {
    let Some(object) = held.as_object_mut() else {
        return;
    };
    if !object.get("type").is_some_and(Value::is_string) {
        return;
    }
    if object.get("value").is_some_and(|inner| !inner.is_null()) {
        return;
    }
    let beside: serde_json::Map<String, Value> = object
        .iter()
        .filter(|(key, _)| key.as_str() != "type" && key.as_str() != "value")
        .map(|(key, inner)| (key.clone(), inner.clone()))
        .collect();
    if beside.is_empty() {
        return;
    }
    for key in beside.keys() {
        object.remove(key);
    }
    object.insert("value".to_owned(), Value::Object(beside));
}

/// The tag and the payload of a value wrapped in a second copy of its own tag, or nothing.
///
/// "Exactly" the pair: the inner object holds a `type` and a `value` and nothing else, so a payload
/// that merely happens to carry a `type` of its own is left alone.
fn a_tag_inside_its_own(held: &Value) -> Option<(String, Value)> {
    let tag = held.get("type")?.as_str()?;
    let inner = held.get("value")?.as_object()?;
    if inner.len() != 2 {
        return None;
    }
    if !inner.get("type")?.as_str()?.eq_ignore_ascii_case(tag) {
        return None;
    }
    Some((tag.to_owned(), inner.get("value")?.clone()))
}

fn repair_tagged(held: &mut Value) {
    fold_the_tag(held);
    unwrap_a_tag_written_twice(held);
    put_the_payload_back_in_its_slot(held);
    let Some(tag) = held.get("type").and_then(Value::as_str) else {
        return;
    };
    let Some((_, payload)) = TAGS.iter().find(|(name, _)| *name == tag) else {
        return;
    };
    let Some(inner) = held.get("value") else {
        return;
    };
    let repaired = match payload {
        Payload::Numbers(_) | Payload::Colour => how_many_numbers(payload)
            .and_then(|count| numbers_under_names(inner, count))
            .map(|numbers| Value::Array(numbers.into_iter().cloned().map(Value::Number).collect())),
        Payload::Numeric => sole_entry(inner).filter(|one| one.is_number()).cloned(),
        Payload::Str => sole_entry(inner).filter(|one| one.is_string()).cloned(),
        Payload::Boolean => sole_entry(inner).filter(|one| one.is_boolean()).cloned(),
        _ => None,
    };
    let Some(repaired) = repaired else {
        return;
    };
    if let Some(object) = held.as_object_mut() {
        object.insert("value".to_owned(), repaired);
    }
}

/// The names a model reaches for when it writes a vector as an object, in the order the protocol
/// wants the numbers in.
///
/// Only sets whose order is not a guess. `{x, y}` is a vector2 and `{r, g, b, a}` is a colour;
/// a rect2's four numbers under any four names are not, so nothing is offered for those.
const ORDERED_NAMES: [&[&str]; 4] = [
    &["x", "y"],
    &["x", "y", "z"],
    &["x", "y", "z", "w"],
    &["r", "g", "b", "a"],
];

/// The numbers of a vector written as an object, in protocol order, or nothing.
fn numbers_under_names(inner: &Value, count: usize) -> Option<Vec<&serde_json::Number>> {
    let object = inner.as_object()?;
    if object.len() != count {
        return None;
    }
    ORDERED_NAMES
        .iter()
        .filter(|names| names.len() == count)
        .find_map(|names| {
            names
                .iter()
                .map(|name| object.get(*name).and_then(Value::as_number))
                .collect::<Option<Vec<&serde_json::Number>>>()
        })
}

/// What arrived, in the words the failure uses. A model that is told only what was wanted has
/// nothing to compare its own call against, which is the whole reason the old sentence failed.
fn describe(value: &Value) -> String {
    match value {
        Value::Null => "null".to_owned(),
        Value::Bool(held) => held.to_string(),
        Value::Number(held) => format!("the number {held}"),
        Value::String(held) => format!("the string {}", json!(held)),
        Value::Array(held) => format!("an array of {}", held.len()),
        Value::Object(held) => {
            let mut names: Vec<&str> = held.keys().map(String::as_str).collect();
            names.sort_unstable();
            if names.is_empty() {
                "an empty object".to_owned()
            } else {
                let written: Vec<String> = names
                    .iter()
                    .map(|name| {
                        if name.trim().is_empty() {
                            json!(name).to_string()
                        } else {
                            (*name).to_owned()
                        }
                    })
                    .collect();
                format!("an object holding {}", written.join(", "))
            }
        }
    }
}

/// What a key is holding, when what it holds is the edge of another operation.
///
/// The two ways an `ops` list comes apart in the recordings, named so the refusal can say which:
/// a closing brace and an opening one, which is the boundary between two entries, and the word
/// that starts an entry.
///
/// Only these. A key with a stray colon or a swallowed quote is torn a different way, and
/// [`torn_object`] and the rename between them already say so.
fn the_start_of_another_operation(key: &str) -> Option<&'static str> {
    let squashed: String = key.chars().filter(|one| !one.is_whitespace()).collect();
    if squashed.contains("},{") {
        return Some("the end of one entry and the start of the next");
    }
    if squashed.contains("\"op\"") || squashed.contains("'op'") {
        return Some("another entry's `op`");
    }
    None
}

/// What to add when the key is not a name at all, but a piece of an object that came apart.
///
/// `{"name': ": ", ", "op": "set_autoload", "path": "res://…"}` is a model whose JSON tore
/// mid-line: the key swallowed a quote and a colon and the value is the fragment left over. The
/// name it meant never reached the wire. Sixteen of these across two live turns, thirteen of them
/// one call resent unchanged, and the autoload was never registered in either.
///
/// The refusal already ended `Did you mean \`name\`?`, and that is the wrong advice here — nothing
/// was misnamed, the object was mis-written, and a model told it picked the wrong word goes looking
/// for a better word. Measured interleaved against a local Qwen3.6-27B, 15 seeds, the same torn
/// call and the same refusal, scored on whether the next call carries a well-formed `name`:
/// **the shipped sentence 0 of 15, this one 15 of 15**. What the shipped arm does instead is
/// abandon the call — it answers with `godot_script list` and `godot_scene get_tree` and never
/// tries the autoload again, which is exactly what both live turns did.
///
/// Only for a key that could not have been a name. An ordinary typo is a word, and for that the
/// hint above is the right answer and this would be nonsense.
fn torn_object(key: &str, value: Option<&Value>) -> String {
    if could_be_a_name(key) {
        return String::new();
    }
    let Some(carried) = value.and_then(|held| serde_json::to_string(held).ok()) else {
        return String::new();
    };
    if carried.chars().count() > 60 {
        return String::new();
    }
    format!(
        " It arrived carrying {carried}, so what went wrong is the object you wrote rather than \
         the word you chose: write the whole call again."
    )
}

/// Takes away a torn key that is a second copy of a pair the object already holds intact.
///
/// Watched live, seventeen times in one turn, the same call every time:
///
/// ```text
/// {"expression": "velocity", "expression}: ": ", ", "frameId': 0}, {": 0, "op": "evaluate"}
/// ```
///
/// `expression` is there and correct. `expression}: ` is the same pair a second time, torn, with a
/// comma for a value — it names nothing the call has not already said, and the call is complete and
/// right without it. Every refusal it earned was about a key the caller could not see, and the
/// caller resent the identical call seventeen times.
///
/// Only that shape: the key holds its name and punctuation and nothing else, the value beside it
/// holds nothing, and the name is a parameter this object already carries. A torn key over a
/// parameter that is *absent* is left alone, because there the caller does have something to write
/// and `check` says so.
fn drop_the_wreckage_of_a_pair_that_survived(
    spec: &[Param],
    object: &mut serde_json::Map<String, Value>,
) {
    let wreckage: Vec<String> = object
        .iter()
        .filter(|(key, held)| tore_away_the_value(key, Some(held)))
        .filter(|(key, _)| {
            let head: String = key
                .chars()
                .take_while(|one| one.is_ascii_alphanumeric() || *one == '_')
                .collect();
            spec.iter().any(|param| param.name == head) && object.contains_key(&head)
        })
        .map(|(key, _)| key.clone())
        .collect();
    for key in wreckage {
        object.remove(&key);
    }
}

/// Puts back a parameter whose whole `name: value,` fragment tore into the key.
///
/// [`only_one_meaning`] renames a torn key only when the *value beside it* carries a letter or a
/// digit, because `"name': ": ", "` would otherwise register an autoload called `, `. That rule is
/// right and this is the case it cannot reach: the value is not beside the key, it is **inside**
/// it. Quoted either way and bare numbers both, because both were watched live — a model that
/// rendered a Python dictionary into its JSON wrote single quotes, and a debugger turn tore
/// `frameId': 0}, {` twice.
///
/// ```text
/// "node': '/GameLevel/Ground', ": ", "
/// ```
///
/// The model rendered a Python dictionary into its JSON — `{'node': '/GameLevel/Ground', …}` — and
/// one whole pair became a key, with the leftover comma and space as its value. The path is not
/// wreckage; it is the thing the call was about. One live turn building a large project met this
/// **thirteen times**: six `set_cells`, four `set_property`, three `create`, each carrying the node
/// path it wanted.
///
/// Only when every part of it is unambiguous: the name is a real parameter of this operation, that
/// parameter takes a string, it is not already there, and no second torn key names it too. Anything
/// else is left for the refusal, which already prints the whole fragment.
fn put_the_pair_back(spec: &[Param], object: &mut serde_json::Map<String, Value>) {
    let found: Vec<(String, &'static str, Value)> = object
        .keys()
        .filter(|key| !spec.iter().any(|param| param.name == key.as_str()))
        .filter_map(|key| {
            let (name, value) = a_torn_pair(key)?;
            let param = spec
                .iter()
                .find(|param| !param.hidden && param.name == name)?;
            fits(param.kind, &value).then(|| (key.clone(), param.name, value))
        })
        .filter(|(_, name, _)| !object.contains_key(*name))
        .collect();
    for (torn, name, value) in &found {
        if found.iter().filter(|(_, other, _)| other == name).count() > 1 {
            continue;
        }
        object.remove(torn.as_str());
        object.insert((*name).to_owned(), value.clone());
    }
}

/// A key that is a whole `name: value,` fragment, read back as the two it was.
///
/// Deliberately strict, in three places. A name-shaped start; nothing but punctuation between it
/// and the colon; and nothing but punctuation after the value, which is the brace and comma the
/// object lost. That last rule is what keeps `size": [32, 32]}]edits` out — the tail carries
/// another call's word, so half of it is not a value to put back.
///
/// The value is a quoted string or a bare number. Both were watched live: `node': '/GameLevel/
/// Ground', ` thirteen times in one turn, and `frameId': 0}, {` twice in another, that one under a
/// value made entirely of the harness's own closing tags.
fn a_torn_pair(key: &str) -> Option<(&str, Value)> {
    let split = key.find(|one: char| !(one.is_ascii_alphanumeric() || one == '_'))?;
    let (name, rest) = key.split_at(split);
    if !could_be_a_name(name) {
        return None;
    }
    let colon = rest.find(':')?;
    if rest[..colon].chars().any(char::is_alphanumeric) {
        return None;
    }
    let (value, tail) = a_leading_scalar(rest[colon + 1..].trim_start())?;
    (!tail.chars().any(char::is_alphanumeric)).then_some((name, value))
}

/// The scalar a fragment opens with, and whatever followed it.
///
/// Quoted either way, because a model that rendered a Python dictionary into its JSON wrote single
/// quotes. Numbers bare. Nothing else: `true`, `false` and `null` are words, and a word here is far
/// more likely to be the wreckage of the next key than a value anybody meant.
fn a_leading_scalar(text: &str) -> Option<(Value, &str)> {
    for quote in ['\'', '"'] {
        if let Some(rest) = text.strip_prefix(quote)
            && let Some((held, tail)) = rest.split_once(quote)
        {
            return Some((Value::String(held.to_owned()), tail));
        }
    }
    let digits = text
        .find(|one: char| !(one.is_ascii_digit() || one == '-' || one == '+' || one == '.'))
        .unwrap_or(text.len());
    let (number, tail) = text.split_at(digits);
    serde_json::from_str::<Value>(number)
        .ok()
        .filter(Value::is_number)
        .map(|held| (held, tail))
}

/// The one parameter a key reads as, with no opinion about what sits beside it.
///
/// [`only_one_meaning`] answers the question a rename asks — which needs the value, because a
/// rename that lands a pair on a parameter that takes a number writes a call the caller did not.
/// Two repairs ask a narrower question: which parameter is this key *about*. An empty key is about
/// something by its name alone, and what it holds is precisely the thing it does not have.
fn the_one_it_reads_as(key: &str, spec: &[Param]) -> Option<&'static str> {
    let mut fitting = spec
        .iter()
        .filter(|param| !param.hidden && reads_as(key, param));
    let first = fitting.next()?;
    fitting.next().is_none().then_some(())?;
    Some(first.name)
}

/// The one parameter a key could have been meant as, or nothing when it could have been two.
///
/// A key that is not shaped like a name has torn out of an object, and then the value beside it
/// decides. Both halves are real, and they are told apart by what arrived, not by the key:
///
/// - `"path:": "scripts/main.gd"` — a stray colon on the key, and the path itself is intact. The
///   model meant `path` and can be given it.
/// - `"name': ": ", "` — the key swallowed a quote and a colon and the value is the comma and space
///   left over. Renaming that registers an autoload called `, `.
///
/// So a torn key is renamed only when its value carries a letter or a digit. Punctuation on its own
/// is the wreckage, and every torn value in the recordings is exactly `", "`. I had this the other
/// way round first — refusing every torn key — and a live debugger turn showed what that costs:
/// three refusals of `path:` in a row, each carrying the path it wanted.
fn only_one_meaning(key: &str, value: Option<&Value>, spec: &[Param]) -> Option<&'static str> {
    if !could_be_a_name(key) && !carries_a_value(value) {
        return None;
    }
    let mut fitting = spec
        .iter()
        .filter(|param| !param.hidden && reads_as(key, param));
    let first = fitting.next()?;
    fitting.next().is_none().then_some(())?;
    value
        .is_some_and(|held| could_become(first.kind, held))
        .then_some(())?;
    if !could_be_a_name(key)
        && !(only_punctuation_past_the_name(key)
            && value.is_some_and(|held| could_become(first.kind, held)))
    {
        return None;
    }
    Some(first.name)
}

/// Whether a value is of a kind, or is one of the shapes the repairs below turn into that kind.
fn could_become(kind: Kind, value: &Value) -> bool {
    if fits(kind, value) {
        return true;
    }
    let mut probe = value.clone();
    unbox_the_one(kind, &mut probe);
    fits(kind, &probe)
}

/// Whether a torn key took the value with it, leaving nothing worth handing back.
///
/// `method": "_on_coin_collected", ` still holds the value the line lost, and naming it back is
/// what tells a model where its value went: 0 of 15 recoveries without that line, 15 of 15 with
/// it. `parent": ` holds the parameter's own name, some punctuation, and nothing else. Naming that
/// back is handing a caller its own wreckage, and the same measurement runs the other way — one
/// live turn resent the identical call thirteen times against it.
///
/// So: nothing alphanumeric past the name-shaped start of the key, and nothing in the value either.
fn tore_away_the_value(key: &str, value: Option<&Value>) -> bool {
    !could_be_a_name(key) && !carries_a_value(value) && only_punctuation_past_the_name(key)
}

/// The name-shaped start of a key, which is the parameter a torn one reads as.
fn the_name_at_the_head(key: &str) -> &str {
    let leading = key
        .chars()
        .take_while(|one| one.is_ascii_alphanumeric() || *one == '_')
        .count();
    &key[..leading]
}

/// Whether a torn key holds nothing past its name-shaped start but punctuation.
///
/// `path:` and `parent": ` do. `size": [32, 32]}]edits` does not — what follows the name is another
/// call's worth of JSON, and neither the value beside such a key nor the value inside it is the one
/// the caller meant.
fn only_punctuation_past_the_name(key: &str) -> bool {
    let leading = key
        .chars()
        .take_while(|one| one.is_ascii_alphanumeric() || *one == '_')
        .count();
    !key[leading..].chars().any(char::is_alphanumeric)
}

/// Whether what arrived is a value at all, rather than punctuation left over from a torn object.
///
/// One letter or digit anywhere in it. `", "` has none; `"scripts/main.gd"`, `"ticks"` and every
/// real value do. A non-string — a number, a flag, a list — is a value by arriving at all.
fn carries_a_value(value: Option<&Value>) -> bool {
    match value {
        None => false,
        Some(Value::String(held)) => held.chars().any(|one| one.is_alphanumeric()),
        Some(Value::Null) => false,
        Some(_) => true,
    }
}

/// Whether a written key is shaped like a parameter name: a letter or underscore, then more of
/// those or digits. Every name in the table is one, and no torn-off fragment of JSON is.
fn could_be_a_name(key: &str) -> bool {
    let mut characters = key.chars();
    characters
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && characters.all(|held| held.is_ascii_alphanumeric() || held == '_')
}

/// The shortest a key may be before it is allowed to answer for a longer name it merely ends.
///
/// Four, which is the floor `_nearest_property` uses in the addon for the same reason: `x` is the
/// tail of half the names in any table, and a rename nobody can predict is worse than a refusal.
const ENOUGH_OF_A_NAME: usize = 4;

/// Whether one written key reads as one declared parameter. The rule [`nearest`] offers hints by.
///
/// The last clause is a **suffix**, and it is there for one shape the recordings hold and no other.
/// `godot_scene create` takes `{path, rootType, rootName?}` while `godot_node create` takes
/// `{parent, type, name, index}`, and models carry the second's words to the first:
///
/// ```text
/// {"op": "create", "path": "res://scenes/x.tscn", "type": "Node2D", "name": "X"}
/// ```
///
/// Scanned across every recorded call, an unknown key that is a case-insensitive suffix of exactly
/// one declared parameter happens **ten times, and all ten are those two** — `name` for `rootName`
/// five times and `type` for `rootType` five. No other operation in the catalogue produces one, so
/// the clause fires where it should and nowhere else. `only_one_meaning` still refuses a contested
/// one, and still refuses a value the parameter could not hold.
fn reads_as(key: &str, param: &Param) -> bool {
    let lowered = key.to_lowercase();
    let name = param.name.to_lowercase();
    name == lowered
        || name.starts_with(&lowered)
        || lowered.starts_with(&name)
        || lowered.replace('_', "") == name.replace('_', "")
        || (lowered.len() >= ENOUGH_OF_A_NAME && name.ends_with(&lowered))
}

/// The accepted name closest to one that was not accepted, when a single edit reaches it. Typos and
/// case slips are the whole population here — `nodePath` for `node`, `Value` for `value` — so a
/// cheap prefix-and-case comparison finds them without a distance matrix.
fn nearest(key: &str, spec: &[Param]) -> Option<&'static str> {
    spec.iter()
        .filter(|param| !param.hidden)
        .find(|param| reads_as(key, param))
        .map(|param| param.name)
}

fn join(message: String, note: &str) -> String {
    if note.is_empty() {
        message
    } else {
        format!("{message} {note}")
    }
}

fn failure(code: &str, message: String, details: Value) -> ToolFailure {
    ToolFailure {
        code: code.to_owned(),
        message,
        retryable: false,
        details,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::ai_tools::CATALOG;
    use crate::tool_params::{params_of, signature};

    fn check_ok(domain: &str, op: &str, params: Value) {
        assert_eq!(check(domain, op, &params), Ok(()), "{domain} {op} {params}");
    }

    fn message(domain: &str, op: &str, params: Value) -> String {
        check(domain, op, &params)
            .expect_err("the call is refused")
            .message
    }

    /// One file's edits, written without the list they go in.
    ///
    /// `godot_script edit` takes `files`, a list of `{path, edits}`. A caller changing one file has
    /// exactly one entry to write, and recorded turns wrote the entry rather than the list — spread
    /// across the call, or under a name of its own. Both say which file and which edits, and both
    /// were refused for the key that was beside the point.
    #[test]
    fn one_entry_of_a_required_list_is_put_in_the_list_it_belongs_to() {
        let edits = json!([{"oldText": "extends Node\nclass_name GameState\n", "newText": "extends Node\n"}]);
        let folded = json!({"files": [{"path": "scripts/game_state.gd", "edits": edits}]});

        let mut spread = json!({"path": "scripts/game_state.gd", "edits": edits});
        repair("godot_script", "edit", &mut spread);
        assert_eq!(spread, folded, "one entry written flat is that entry");
        check_ok("godot_script", "edit", spread);

        let mut named = json!({"edit": {"path": "scripts/game_state.gd", "edits": edits}});
        repair("godot_script", "edit", &mut named);
        assert_eq!(named, folded, "one entry under one key is that entry");

        let mut partial = json!({"edits": edits});
        repair("godot_script", "edit", &mut partial);
        assert!(
            message("godot_script", "edit", partial).contains("files"),
            "an entry with no path names no file, and nothing here invents one"
        );
    }

    /// A whole operation written to the wrong tool, and the sentence that says which one it is.
    ///
    /// `loc-12-mainscene` wrote eight operations to `godot_scene`, seven of them node creations,
    /// was refused for one key, and **resent all eight byte for byte**. The refusal had asked it to
    /// correct one key and send the list again, and there is no correction to `{parent, name, type}`
    /// that makes `godot_scene create` take it.
    #[test]
    fn an_operation_written_to_the_wrong_tool_is_told_which_tool_it_is() {
        let misplaced = json!({"parent": "/Platformer", "name": "Floor", "type": "StaticBody2D"});

        let mut untouched = misplaced.clone();
        repair("godot_scene", "create", &mut untouched);
        assert_eq!(
            untouched, misplaced,
            "a call in the wrong place is not repaired into one"
        );

        let refused = message("godot_scene", "create", misplaced);
        assert!(
            refused.contains("godot_node create's parameter list exactly"),
            "the refusal names the operation these parameters are: {refused}"
        );

        let vague = message(
            "godot_scene",
            "get_tree",
            json!({"path": "res://main.tscn"}),
        );
        assert!(
            !vague.contains("parameter list exactly"),
            "a shape that fits everything says nothing: {vague}"
        );

        let mut synonym = json!({"node": "/root/Game/Player", "properties": ["global_position"]});
        repair("godot_runtime", "inspect_node", &mut synonym);
        check_ok("godot_runtime", "inspect_node", synonym);
    }

    /// A tagged value's payload, written beside the tag instead of inside it.
    ///
    /// Twelve of these across four runs, every one attaching a script, a texture or a shape. The
    /// tag says `resource` and the path says which one, and the slot that had to hold it is empty
    /// or absent — so the refusal said "this one was null", which describes the shape and not the
    /// mistake.
    #[test]
    fn a_payload_written_beside_its_tag_is_put_back_in_its_slot() {
        let attached = json!({"type": "resource", "value": {"path": "res://scripts/player.gd"}});
        for written in [
            json!({"path": "res://scripts/player.gd", "type": "resource", "value": null}),
            json!({"path": "res://scripts/player.gd", "type": "resource"}),
        ] {
            let mut call =
                json!({"node": "/Main/Player", "property": "script", "value": written.clone()});
            repair("godot_node", "set_property", &mut call);
            assert_eq!(call["value"], attached, "written as {written}");
            check_ok("godot_node", "set_property", call);
        }

        for whole in [
            json!({"type": "vector2", "value": [12, 34]}),
            json!({"type": "resource", "value": {"path": "res://scripts/player.gd"}}),
            json!({"type": "null", "value": null}),
        ] {
            let mut call =
                json!({"node": "/Main/Player", "property": "script", "value": whole.clone()});
            repair("godot_node", "set_property", &mut call);
            assert_eq!(
                call["value"], whole,
                "a whole tagged value is not rearranged"
            );
        }

        let entry = json!({"name": "Player", "parent": "/Main", "type": "CharacterBody2D"});
        let mut creation = json!({"nodes": [entry.clone()]});
        repair("godot_node", "create_nodes", &mut creation);
        assert_eq!(
            creation["nodes"][0], entry,
            "`type` here is a class, not a tag"
        );
        check_ok("godot_node", "create_nodes", creation);
    }

    /// A value of the smallest shape a parameter of this kind will take.
    ///
    /// Only what the kind needs to be legal — a path is `"a"` and a number is `1`, because what is
    /// under test is whether `repair` leaves a whole call alone, not whether the value is sensible.
    fn something_of(kind: Kind) -> Value {
        match kind {
            Kind::Text => json!("a"),
            Kind::Hash => json!("0".repeat(64)),
            Kind::Int => json!(1),
            Kind::Number => json!(1.5),
            Kind::Flag => json!(true),
            Kind::List | Kind::ListOf(_) => json!([]),
            Kind::Object => json!({}),
            Kind::Tagged => json!({"type": "int", "value": 1}),
            Kind::Choice(words) => json!(words.first().copied().unwrap_or("a")),
            Kind::Either(kinds) => kinds
                .first()
                .map_or_else(|| json!("a"), |first| something_of(*first)),
        }
    }

    /// The smallest call an operation accepts: every required parameter and nothing else.
    fn the_least_call(params: &[Param]) -> Value {
        let mut call = serde_json::Map::new();
        for param in params
            .iter()
            .filter(|param| param.required && !param.hidden)
        {
            let held = if param.kind == Kind::List && !param.entry.is_empty() {
                json!([the_least_call(param.entry)])
            } else {
                something_of(param.kind)
            };
            call.insert(param.name.to_owned(), held);
        }
        Value::Object(call)
    }

    /// A call the router already accepts is never rewritten, for any operation in the catalogue.
    ///
    /// Every repair here reads one key, or one shape, and asks whether it could have meant
    /// something else. Applied to a call that is already right, the honest answer is always "no" —
    /// and two of them got that wrong. `the_word_the_operation_does_not_use` renamed a field of a
    /// parameter onto the parameter, because the parameter's note mentioned it. The misplaced-call
    /// guard read every good `add_to_group` as a `remove_from_group`, because the two take the same
    /// two parameters, and stopped repairing anything in it.
    ///
    /// Both were found by something else — a probe and two red tests — and neither had to be. This
    /// asks all three questions of every operation in the catalogue: that nothing is rewritten,
    /// that nothing moves on a second pass, and that no good call is read as belonging somewhere
    /// else. The third is separate because the second one it caught was invisible to the first:
    /// the guard did not rewrite the call, it stopped every repair from running on it, and a call
    /// that came out equal is exactly what that looks like.
    ///
    /// Measured beside it, over the whole recorded corpus: of 4,949 operations, **not one call the
    /// router accepts is touched by `repair`**, and none moves on a second pass.
    #[test]
    fn a_call_the_router_already_accepts_is_never_rewritten() {
        let mut seen = 0usize;
        for domain in CATALOG {
            for operation in domain.operations {
                let Some(params) = params_of(domain.name, operation.op) else {
                    continue;
                };
                let least = the_least_call(params);
                if check(domain.name, operation.op, &least).is_err() {
                    continue;
                }
                seen += 1;
                assert_eq!(
                    the_operation_these_keys_belong_to(
                        &format!("{} {}", domain.name, operation.op),
                        params,
                        least.as_object().expect("an object")
                    ),
                    None,
                    "{} {} was read as another operation's call",
                    domain.name,
                    operation.op
                );
                let mut once = least.clone();
                repair(domain.name, operation.op, &mut once);
                assert_eq!(
                    once, least,
                    "{} {} was rewritten though it was already right",
                    domain.name, operation.op
                );
                let mut twice = once.clone();
                repair(domain.name, operation.op, &mut twice);
                assert_eq!(
                    twice, once,
                    "{} {} does not settle: repair moves its own output",
                    domain.name, operation.op
                );
            }
        }
        assert!(
            seen > 80,
            "the builder has to reach most of the catalogue for this to mean anything: {seen}"
        );
        println!("checked {seen} operations");
    }

    /// A key that is the name of the operation next door.
    ///
    /// `godot_runtime input` was sent `capture` in two runs. It is not a parameter of `input` and
    /// never will be; it is the operation beside it, and a call carries a list of operations.
    #[test]
    fn a_key_that_names_another_operation_of_this_tool_is_told_it_is_one() {
        let refused = message(
            "godot_runtime",
            "input",
            json!({"events": [{"kind": "key", "key": "Right"}], "capture": true}),
        );
        assert!(
            refused.contains("`capture` is an operation of this tool")
                && refused.contains("its own entry"),
            "{refused}"
        );

        let itself = message(
            "godot_runtime",
            "input",
            json!({"events": [], "input": true}),
        );
        assert!(
            !itself.contains("is an operation of this tool"),
            "an operation is not next door to itself: {itself}"
        );

        let spelled = message("godot_runtime", "run", json!({"scenes": "res://a.tscn"}));
        assert!(
            spelled.contains("Did you mean `scene`?"),
            "the spelling hint still wins where it applies: {spelled}"
        );
    }

    /// A number written onto the end of the parameter it belongs to.
    ///
    /// `loc-63-resources` sent `{"limit20": true, "sourceeditor": "editor"}` twice and then wrote
    /// `{"limit": 20, "source": "editor"}` itself, which is the reading this takes.
    #[test]
    fn a_number_glued_to_a_parameters_name_is_taken_off_it() {
        let mut torn = json!({
            "contains": "AREA",
            "limit20": true,
            "sourceeditor": "editor",
        });
        repair("godot_logs", "read", &mut torn);
        assert_eq!(
            torn,
            json!({"contains": "AREA", "limit": 20, "source": "editor"}),
            "the caller's own next call is the answer"
        );
        check_ok("godot_logs", "read", torn);

        let mut usable = json!({"limit20": 5});
        repair("godot_logs", "read", &mut usable);
        assert_eq!(
            usable,
            json!({"limit": 5}),
            "the number beside the key is kept, and the digits in the key are not read as a second"
        );
        let mut held = json!({"limit": 10, "limit20": true});
        repair("godot_logs", "read", &mut held);
        assert_eq!(
            held,
            json!({"limit": 10, "limit20": true}),
            "the answer is already written"
        );

        let mut wordy = json!({"contains2": true});
        repair("godot_logs", "read", &mut wordy);
        assert!(
            message("godot_logs", "read", wordy).contains("`contains2`"),
            "a text parameter's name with digits on it is not a torn number"
        );
    }

    /// No parameter is named with a number on the end, which is what makes the repair above safe.
    #[test]
    fn no_parameter_is_named_with_a_number_on_the_end() {
        let mut named = Vec::new();
        fn walk(params: &[Param], named: &mut Vec<&'static str>) {
            for param in params {
                if param.name.ends_with(|c: char| c.is_ascii_digit()) {
                    named.push(param.name);
                }
                walk(param.entry, named);
            }
        }
        for domain in CATALOG {
            for operation in domain.operations {
                if let Some(params) = params_of(domain.name, operation.op) {
                    walk(params, &mut named);
                }
            }
        }
        assert!(
            named.is_empty(),
            "a parameter whose name ends in a digit makes `a_number_written_onto_its_own_name` \
             ambiguous, and the repair has to go before the name does: {named:?}"
        );
    }

    /// The router's own parameter is not one the caller wrote.
    ///
    /// `expectedRevision` is supplied from the last answer that carried one and lands in the object
    /// before any repair runs. Counted as a written key it made `{parent, name, type}` fit nothing,
    /// and `loc-71-autoload` was answered about `parent` — three wrong words instead of one
    /// misplaced operation. Adding that one key reproduces the live message exactly, which is how
    /// the difference between the live run and a probe of the same object was finally read.
    #[test]
    fn a_parameter_the_router_supplies_does_not_hide_a_misplaced_operation() {
        for call in [
            json!({"name": "ScoreLabel", "parent": "/Main", "type": "Label"}),
            json!({"name": "ScoreLabel", "parent": "/Main", "type": "Label", "expectedRevision": 3}),
        ] {
            let mut held = call.clone();
            repair("godot_scene", "create", &mut held);
            assert_eq!(held, call, "a misplaced call is left as written: {call}");
            let said = message("godot_scene", "create", held);
            assert!(
                said.contains("godot_node create's parameter list exactly"),
                "with or without the router's own key: {said}"
            );
        }
    }

    /// Every operation whose parameters name it uniquely, sent to a tool that cannot take them.
    ///
    /// The rule this exercises reads the whole key set, and iteration 140 found that a key the
    /// router supplies — `expectedRevision`, `scene`, `expectedHash` — was counted as one the
    /// caller wrote, which made the set fit nothing. The recorded corpus cannot show that: it holds
    /// what the model sent, not what the router added on the way. So the question is asked of the
    /// catalogue instead, and asked twice, once with the supplied keys in place.
    #[test]
    fn a_misplaced_call_is_named_with_or_without_the_keys_the_router_adds() {
        let mut asked = 0usize;
        for domain in CATALOG {
            for operation in domain.operations {
                let Some(params) = params_of(domain.name, operation.op) else {
                    continue;
                };
                let least = the_least_call(params);
                let Some(object) = least.as_object() else {
                    continue;
                };
                let named = format!("{} {}", domain.name, operation.op);
                let mut fitting: Vec<(&str, &str)> = CATALOG
                    .iter()
                    .flat_map(|other| other.operations.iter().map(move |op| (other.name, op.op)))
                    .filter(|(tool, op)| {
                        let sent = format!("{tool} {op}");
                        sent != named
                            && params_of(tool, op).is_some_and(|spec| {
                                the_operation_these_keys_belong_to(&sent, spec, object).as_deref()
                                    == Some(named.as_str())
                            })
                    })
                    .collect();
                fitting.sort_by_key(|(tool, op)| {
                    u8::from(
                        !params_of(tool, op)
                            .is_some_and(|spec| spec.iter().any(|param| param.hidden)),
                    )
                });
                let Some((tool, op)) = fitting.first().copied() else {
                    continue;
                };
                let spec = params_of(tool, op).expect("the operation it was sent to");
                let mut carried = object.clone();
                if spec.iter().any(|param| param.hidden) {
                    asked += 1;
                }
                for param in spec.iter().filter(|param| param.hidden) {
                    carried.insert(
                        param.name.to_owned(),
                        match param.kind {
                            Kind::Int => json!(3),
                            Kind::Hash => json!("0".repeat(64)),
                            _ => json!("res://main.tscn"),
                        },
                    );
                }
                assert_eq!(
                    the_operation_these_keys_belong_to(&format!("{tool} {op}"), spec, &carried)
                        .as_deref(),
                    Some(named.as_str()),
                    "{tool} {op} stopped naming {named} once the router's own keys were in the call"
                );
            }
        }
        assert!(
            asked > 5,
            "the catalogue has to offer some of these: {asked}"
        );
        println!("checked {asked} misplaced shapes");
    }

    /// A word one tool uses for a thing the tool next door names differently.
    ///
    /// `godot_runtime inspect_node` takes `path`, and `path` everywhere else in the catalogue is a
    /// file. Its note says so, and says what `godot_node` calls the same thing. Twelve recorded
    /// runs wrote `node` there anyway. Nothing spells its way from `node` to `path`, so every
    /// rename in this file walked past it.
    #[test]
    fn a_key_a_parameters_own_note_calls_it_by_is_renamed_onto_that_parameter() {
        let mut written = json!({"node": "/root/Game/Player", "properties": ["global_position"]});
        repair("godot_runtime", "inspect_node", &mut written);
        assert_eq!(
            written,
            json!({"path": "/root/Game/Player", "properties": ["global_position"]}),
            "the note names `node`, so the key it names is the one that moves"
        );
        check_ok("godot_runtime", "inspect_node", written);

        let mut elsewhere = json!({"node": "/Main/Coin", "path": "res://scenes/coin.tscn"});
        repair("godot_node", "instantiate", &mut elsewhere);
        assert_eq!(
            elsewhere,
            json!({"node": "/Main/Coin", "path": "res://scenes/coin.tscn"}),
            "a parameter that has never been called `node` does not take one"
        );
        assert!(
            message("godot_node", "instantiate", elsewhere).contains("has no `node` parameter"),
            "and the caller is told about the key it wrote"
        );

        let mut inside = json!({"oldText": ["var speed := 1.0"]});
        repair("godot_script", "edit", &mut inside);
        assert_eq!(
            inside,
            json!({"oldText": ["var speed := 1.0"]}),
            "a field of the parameter is not a second name for the parameter"
        );

        let mut planned = json!({"rename": [{"path": "a.gd"}]});
        repair("godot_script", "apply_rename", &mut planned);
        assert_eq!(
            planned,
            json!({"files": [{"path": "a.gd"}]}),
            "the list is the plan"
        );
        let mut wrapped = json!({"rename": {"files": [{"path": "a.gd"}]}});
        repair("godot_script", "apply_rename", &mut wrapped);
        assert!(
            message("godot_script", "apply_rename", wrapped).contains("has no `rename`"),
            "the whole answer is not the list, and is not read as one"
        );
    }

    /// A colour may be written the way Godot writes one, and the way it always could.
    ///
    /// `resource.create_texture` takes "skyblue" and "#8b5a2b" because `Color.from_string` does,
    /// and a `color` value refusing them made the same tool spell a colour two ways. One live turn
    /// wrote "red" for a `modulate` and was told a colour is four numbers.
    #[test]
    fn a_colour_may_be_named_as_well_as_counted() {
        for value in [
            json!({"type": "color", "value": "red"}),
            json!({"type": "color", "value": "#8b5a2b"}),
            json!({"type": "color", "value": [1, 0.5, 0.25, 1]}),
        ] {
            check_ok(
                "godot_node",
                "set_property",
                json!({"node": "/Main/Player", "property": "modulate", "value": value}),
            );
        }

        let neither = message(
            "godot_node",
            "set_property",
            json!({
                "node": "/Main/Player",
                "property": "modulate",
                "value": {"type": "color", "value": 7}
            }),
        );
        assert!(neither.contains("name like skyblue"), "{neither}");
    }

    /// A resource wrapper that is right with a path that is empty says so, rather than contradicting
    /// itself.
    ///
    /// Observed live: `{"type": "resource", "value": {"path": ""}}` for a material the turn had not
    /// made yet, answered `a resource value takes an object carrying a path, and this one was an
    /// object holding path` — a sentence that says the shape is wrong when the shape is right, and
    /// never names the empty string that is.
    #[test]
    fn an_empty_resource_path_is_named_as_one() {
        let empty = message(
            "godot_node",
            "set_property",
            json!({
                "node": "/Game/Ground",
                "property": "material",
                "value": {"type": "resource", "value": {"path": ""}}
            }),
        );
        assert!(
            empty.contains("this one's is empty") && !empty.contains("an object holding path"),
            "{empty}"
        );

        let shapeless = message(
            "godot_node",
            "set_property",
            json!({
                "node": "/Game/Ground",
                "property": "material",
                "value": {"type": "resource", "value": {"res": "a.tres"}}
            }),
        );
        assert!(
            shapeless.contains("an object carrying a path"),
            "{shapeless}"
        );
    }

    /// The whitespace round a name is trimmed off it; the whitespace inside content is not.
    ///
    /// Observed live, twelve times running: `{"parent ": "/Level3D ", "type ":
    /// "DirectionalLight3D"}`. The padded *key* has been repaired for a while, and the padded
    /// *value* went through untouched — so the refusal read `Node /Level3D  was not found … the
    /// scene's own root is /Level3D`, two strings that look identical on screen.
    #[test]
    fn the_whitespace_round_a_name_is_not_part_of_it() {
        let mut padded = json!({"type ": "DirectionalLight3D", "name": " Light "});
        padded["parent "] = json!("/Level3D ");
        repair("godot_node", "create", &mut padded);
        assert_eq!(padded["parent"], json!("/Level3D"), "{padded}");
        assert_eq!(padded["type"], json!("DirectionalLight3D"), "{padded}");
        assert_eq!(padded["name"], json!("Light"), "{padded}");
        check_ok("godot_node", "create", padded);

        let mut shape = json!({"path": " a.tres ", "shapeType": "CircleShape2D ", "radius": 4});
        repair("godot_resource", "create_shape", &mut shape);
        assert_eq!(shape["shapeType"], json!("CircleShape2D"), "{shape}");
        assert_eq!(shape["path"], json!("a.tres"), "{shape}");
        check_ok("godot_resource", "create_shape", shape);

        let mut written = json!({"path": "a.gd", "text": "extends Node\n\n\n"});
        repair("godot_script", "save", &mut written);
        assert_eq!(written["text"], json!("extends Node\n\n\n"), "{written}");
        let mut edited = json!({
            "files": [{"path": "a.gd", "edits": [{"oldText": "  x = 1\n", "newText": "  x = 2\n"}]}]
        });
        repair("godot_script", "edit", &mut edited);
        assert_eq!(
            edited["files"][0]["edits"][0]["oldText"],
            json!("  x = 1\n"),
            "{edited}"
        );

        let mut formatting =
            json!({"source": "extends Node\n\n\nfunc value() -> int:\n\treturn 1\n"});
        repair("godot_script", "format", &mut formatting);
        assert_eq!(
            formatting["source"],
            json!("extends Node\n\n\nfunc value() -> int:\n\treturn 1\n"),
            "{formatting}"
        );
        check_ok("godot_script", "format", formatting);
    }

    /// A torn second copy of a pair the object already holds is thrown away, not refused.
    ///
    /// Observed live, seventeen times in one turn — the same `godot_debug evaluate` call each time,
    /// with `expression` present and correct beside a torn `expression}: ` carrying a comma. Every
    /// refusal was about a key the caller could not see in what it thought it had written, and it
    /// resent the identical call seventeen times.
    #[test]
    fn a_torn_second_copy_of_a_pair_that_survived_is_thrown_away() {
        let mut doubled = json!({"expression": "velocity"});
        doubled["expression}: "] = json!(", ");
        doubled["frameId': 0}, {"] = json!(0);
        repair("godot_debug", "evaluate", &mut doubled);
        assert_eq!(doubled["expression"], json!("velocity"), "{doubled}");
        assert_eq!(doubled["frameId"], json!(0), "{doubled}");
        assert!(doubled.get("expression}: ").is_none(), "{doubled}");
        check_ok("godot_debug", "evaluate", doubled);

        let mut absent = json!({"frameId": 0});
        absent["expression}: "] = json!(", ");
        repair("godot_debug", "evaluate", &mut absent);
        assert!(absent.get("expression}: ").is_some(), "{absent}");
        let refused = message("godot_debug", "evaluate", absent);
        assert!(refused.contains("requires `expression`"), "{refused}");

        let mut optional = json!({"parent": "/Game", "path": "res://enemy.tscn"});
        optional["name\": "] = json!(", ");
        let torn = check("godot_node", "instantiate", &optional).expect_err("refused");
        assert_eq!(torn.code, "torn_param", "{}", torn.message);
        assert!(
            torn.message.contains("lost `name` to a torn key")
                && !torn.message.contains("name\": "),
            "{}",
            torn.message
        );
    }

    /// A refusal does not read a torn key's wreckage back into the conversation.
    ///
    /// Observed live, three times running: the key opened `size=[32, 64]}]` and went on for
    /// another eighty characters of the model's own harness tags — closing `parameter`, `function`
    /// and `tool_call` markers, inside its own JSON, followed by a sentence about fixing the
    /// syntax and a fresh opening tag. The refusal quoted every one of them back.
    /// The head is what says a key tore; the tail is the part not to repeat.
    #[test]
    fn a_refusal_quotes_the_head_of_a_torn_key_and_not_its_wreckage() {
        let mut wrecked = json!({"path": "a.tres", "shapeType": "RectangleShape2D"});
        let key = "size=[32, 64]}]'</parameter>]</parameter>></function></tool_call></parameter>   \
                   Let me fix the syntax. <tool_call>1;0;0}{";
        wrecked[key] = json!(1);
        let refused = message("godot_resource", "create_shape", wrecked);
        assert!(
            refused.contains("size=[32, 64]"),
            "the head is the evidence: {refused}"
        );
        assert!(
            !refused.contains("</function>"),
            "and the tail is not: {refused}"
        );
        assert!(refused.contains('…'), "{refused}");
    }

    /// Two calls that ran into each other are refused, not renamed onto a parameter that fits.
    ///
    /// Observed live, three times running: `{"op": "create_shape", "path": …, "shapeType":
    /// "RectangleShape2D", "size\": [32, 32]}]edits": [ …a scene's worth of edits… ]}`. The key
    /// reads as `size`, and what came with it was a list — which is exactly what `size` takes — so
    /// the rename fired, the gate passed it, and the addon answered "A RectangleShape2D takes size
    /// as two numbers" about a call whose real `[32, 32]` was sitting inside the key. The turn gave
    /// up and hand-wrote the `.tres` with the file tools, twice, getting the syntax wrong the first
    /// time and running the game into a parse error.
    #[test]
    fn two_calls_that_ran_into_each_other_are_refused_rather_than_renamed() {
        let mut merged = json!({
            "path": "assets/player_shape.tres",
            "shapeType": "RectangleShape2D"
        });
        merged["size\": [32, 32]}]edits"] = json!([{"newText": "[gd_scene load_steps=5]"}]);
        repair("godot_resource", "create_shape", &mut merged);
        assert!(
            merged.get("size").is_none(),
            "another call's list must not be renamed onto `size`: {merged}"
        );
        let refused = check("godot_resource", "create_shape", &merged).expect_err("refused");
        assert_eq!(refused.code, "unknown_param", "{}", refused.message);
        assert!(
            refused.message.contains("Did you mean `size`?"),
            "the hint still names what it read as: {}",
            refused.message
        );
        assert!(
            refused.message.contains("It arrived carrying"),
            "the refusal quotes the scrap that arrived: {}",
            refused.message
        );

        let mut colon = json!({"shapeType": "RectangleShape2D"});
        colon["path:"] = json!("assets/player_shape.tres");
        repair("godot_resource", "create_shape", &mut colon);
        assert_eq!(colon["path"], json!("assets/player_shape.tres"), "{colon}");
    }

    /// A tear that took the value with it is answered with what is missing, not with the wreckage.
    ///
    /// Observed live, thirteen times running in one turn: `{"name": "Enemy", "op": "instantiate",
    /// "parent": ": ", "}` — the key holding the parameter's own name and a quote and a colon, the
    /// value holding a comma. The refusal named that key back, and the model, which had written no
    /// such key it could see, resent the identical call thirteen times before abandoning the
    /// operation and hand-writing the resource with the file tools.
    ///
    /// The counter-case is the one right above it and is not changed: a key that still carries the
    /// value the line lost is named back, because that is what tells a model where its value went.
    #[test]
    fn a_tear_that_took_the_value_is_answered_with_what_is_missing() {
        let mut torn = json!({"name": "Enemy"});
        torn["parent\": "] = json!(", ");
        let refused = message("godot_node", "instantiate", torn);
        assert!(
            refused.contains("requires `parent`") && refused.contains("One key arrived torn"),
            "the refusal has to lead with what the call needs: {refused}"
        );
        assert!(
            !refused.contains("parent\": "),
            "and must not hand the wreckage back: {refused}"
        );
        assert!(
            refused.contains("This one carries name."),
            "the keys that did survive are still named: {refused}"
        );
    }

    /// A key that tore is renamed only when the value beside it survived the tear.
    ///
    /// Observed live, twice in one turn and then a third time: `{"op": "create_shape", "path": …,
    /// "shapeType": "RectangleShape2D", "size)": false}`. `size)` reads as `size`, so the rename
    /// fired and the refusal became ``\`size\` takes an array, and this one was false`` — about a
    /// key the model had never written. It resent the identical call, then gave up on the operation
    /// and hand-wrote the `.tres` with the file tools, which is the door this one exists to close.
    ///
    /// A torn key whose value did survive is still renamed: that is the whole point of the rule,
    /// and `nameSettings` for `name` is the case it was built for.
    #[test]
    fn a_key_that_tore_is_renamed_only_when_its_value_survived() {
        let mut torn = json!({
            "path": "scenes/enemy_shape.tres",
            "shapeType": "RectangleShape2D",
            "size)": false
        });
        repair("godot_resource", "create_shape", &mut torn);
        assert!(
            torn.get("size).").is_none() && torn.get("size").is_none(),
            "a torn key over a value that cannot be a size must not be renamed onto it: {torn}"
        );
        let refused = message("godot_resource", "create_shape", torn);
        assert!(
            refused.contains("`size)`") && refused.contains("write the whole call again"),
            "the refusal has to name the key that arrived: {refused}"
        );

        let mut readable = json!({
            "path": "scenes/enemy_shape.tres",
            "shapeType": "RectangleShape2D",
            "size)": [32, 32]
        });
        repair("godot_resource", "create_shape", &mut readable);
        assert_eq!(readable["size"], json!([32, 32]), "{readable}");
    }

    /// The same value written twice under two wrong names is one answer, not two.
    ///
    /// A live turn adding a jump to a platformer sent this to `create_shape`, in both of the
    /// operations in one call:
    ///
    /// ```text
    /// {"op": "create_shape", "path": "res://shapes/player_shape.tres",
    ///  "shapeType": "RectangleShape2D", "size2": [16, 16], "size_value": [16, 16]}
    /// ```
    ///
    /// `size2` and `size_value` both read as `size`, so the contested-rename rule took neither and
    /// the whole call came back ``has no `size2` parameter … Did you mean `size`?`` — a sentence
    /// about one of the two keys that says nothing about the other. Nothing had to be picked
    /// between them: both hold `[16, 16]`, and `size` holds `[16, 16]` either way.
    #[test]
    fn a_contest_whose_keys_agree_is_settled_rather_than_refused() {
        let mut said_twice = json!({
            "path": "res://shapes/player_shape.tres",
            "shapeType": "RectangleShape2D",
            "size2": [16, 16],
            "size_value": [16, 16]
        });
        repair("godot_resource", "create_shape", &mut said_twice);
        assert_eq!(said_twice["size"], json!([16, 16]), "{said_twice}");
        assert!(
            said_twice.get("size2").is_none() && said_twice.get("size_value").is_none(),
            "the keys that were read are taken away: {said_twice}"
        );
        check_ok("godot_resource", "create_shape", said_twice);

        let mut disagrees = json!({
            "path": "res://shapes/player_shape.tres",
            "shapeType": "RectangleShape2D",
            "size2": [16, 16],
            "size_value": [32, 32]
        });
        repair("godot_resource", "create_shape", &mut disagrees);
        assert!(
            disagrees.get("size").is_none(),
            "neither of two different answers may be taken: {disagrees}"
        );
        let refused = message("godot_resource", "create_shape", disagrees);
        assert!(refused.contains("`size2`"), "{refused}");
    }

    /// The list written under a name the operation does not have is renamed onto the one it fits.
    ///
    /// Three live turns sent `godot_script edit` its own `files` list under the name `edits`, and
    /// each was answered with a signature quoting the shape it had already written correctly.
    #[test]
    fn a_list_written_under_another_name_is_renamed_onto_the_one_it_fits() {
        let mut misnamed = json!({
            "edits": [{
                "path": "scripts/player.gd",
                "edits": [{"oldText": "var travelled := 0.0", "newText": "var travelled := 1.0"}]
            }]
        });
        repair("godot_script", "edit", &mut misnamed);
        assert!(misnamed.get("edits").is_none(), "{misnamed}");
        assert_eq!(misnamed["files"][0]["path"], json!("scripts/player.gd"));
        check_ok("godot_script", "edit", misnamed);

        let mut already_there = json!({
            "files": [{"path": "a.gd", "edits": [{"oldText": "a", "newText": "b"}]}],
            "somethings": [{"path": "b.gd", "edits": [{"oldText": "c", "newText": "d"}]}]
        });
        repair("godot_script", "edit", &mut already_there);
        assert!(already_there.get("somethings").is_some(), "{already_there}");
        assert!(message("godot_script", "edit", already_there).contains("`somethings`"));

        let mut partial = json!({"somethings": [{"path": "a.gd"}]});
        repair("godot_script", "edit", &mut partial);
        assert!(partial.get("somethings").is_some(), "{partial}");

        let mut extra = json!({
            "somethings": [{
                "path": "a.gd",
                "edits": [{"oldText": "a", "newText": "b"}],
                "why": "because"
            }]
        });
        repair("godot_script", "edit", &mut extra);
        assert!(extra.get("somethings").is_some(), "{extra}");
    }

    /// A path written flat beside the `files` list that already carries it is taken away.
    ///
    /// Three live turns sent `godot_script edit` this, each with the same path in both places:
    ///
    /// ```text
    /// {"op": "edit", "files": [{"path": "scripts/player.gd", "edits": […]}],
    ///  "path": "scripts/player.gd"}
    /// ```
    ///
    /// `edit` has no `path` — `save` does — so the whole call was refused over a key that repeated
    /// what the entry inside `files` already said.
    #[test]
    fn a_value_the_list_already_carries_is_not_written_flat_beside_it() {
        let mut said_twice = json!({
            "files": [{
                "path": "scripts/player.gd",
                "edits": [{"oldText": "var travelled := 0.0", "newText": "var travelled := 1.0"}]
            }],
            "path": "scripts/player.gd"
        });
        repair("godot_script", "edit", &mut said_twice);
        assert!(
            said_twice.get("path").is_none(),
            "the flat copy is taken away: {said_twice}"
        );
        check_ok("godot_script", "edit", said_twice);

        let mut disagrees = json!({
            "files": [{
                "path": "scripts/player.gd",
                "edits": [{"oldText": "var travelled := 0.0", "newText": "var travelled := 1.0"}]
            }],
            "path": "scripts/enemy.gd"
        });
        repair("godot_script", "edit", &mut disagrees);
        assert_eq!(disagrees["path"], json!("scripts/enemy.gd"), "{disagrees}");
        assert!(message("godot_script", "edit", disagrees).contains("`path`"));
    }

    /// The node written under the name a sibling operation gives it, beside the right one.
    ///
    /// Two live turns on `gemma-4-31b` sent `godot_node create` this, identically. `node` is what
    /// `set_property` and `connect_signal` call the node; `create` calls it `parent`; the model
    /// wrote the value under both. The whole call — five operations — was refused over a key
    /// holding a string the call already held.
    #[test]
    fn a_key_repeating_a_required_parameter_is_dropped_as_the_copy_it_is() {
        let mut said_twice = json!({
            "name": "TickTimer",
            "node": "/ProtocolFixture",
            "parent": "/ProtocolFixture",
            "type": "Timer"
        });
        repair("godot_node", "create", &mut said_twice);
        assert!(said_twice.get("node").is_none(), "{said_twice}");
        check_ok("godot_node", "create", said_twice);

        let mut elsewhere = json!({
            "name": "TickTimer",
            "node": "/Somewhere",
            "parent": "/ProtocolFixture",
            "type": "Timer"
        });
        repair("godot_node", "create", &mut elsewhere);
        assert_eq!(elsewhere["node"], json!("/Somewhere"), "{elsewhere}");
        assert!(message("godot_node", "create", elsewhere).contains("`node`"));

        let mut incomplete = json!({"name": "TickTimer", "node": "/ProtocolFixture"});
        repair("godot_node", "create", &mut incomplete);
        assert_eq!(
            incomplete["node"],
            json!("/ProtocolFixture"),
            "{incomplete}"
        );
    }

    /// A value with the tear's own punctuation behind it is still the value.
    ///
    /// Three live `godot_logs read` calls tore the same way, and each went round the repeat guard —
    /// whose answer on `godot_logs` recovered 1 time in 10, the worst measured anywhere:
    ///
    /// ```text
    /// {"afterCursor": 37, "contains\":": "test", "limit\":\": 40, ": "", "op": "read"}
    /// {"afterSequence": 600, "limit\":\": 60}]": null, "op": "read", "source": "editor"}
    /// ```
    #[test]
    fn a_scalar_with_the_tears_punctuation_behind_it_is_read_as_the_value() {
        let mut trailing_comma = json!({"limit\":\": 40, ": "", "source": "editor"});
        repair("godot_logs", "read", &mut trailing_comma);
        assert_eq!(trailing_comma["limit"], json!(40), "{trailing_comma}");
        check_ok("godot_logs", "read", trailing_comma);

        let mut trailing_brackets = json!({"limit\":\": 60}]": null, "source": "editor"});
        repair("godot_logs", "read", &mut trailing_brackets);
        assert_eq!(trailing_brackets["limit"], json!(60), "{trailing_brackets}");
        check_ok("godot_logs", "read", trailing_brackets);

        let mut half_a_list = json!({
            "path": "res://shapes/x.tres",
            "shapeType": "RectangleShape2D",
            "size 16, 16]": null
        });
        repair("godot_resource", "create_shape", &mut half_a_list);
        assert!(
            half_a_list.get("size").is_none(),
            "half a list is not a size: {half_a_list}"
        );

        let mut whole = json!({
            "path": "res://shapes/x.tres",
            "shapeType": "RectangleShape2D",
            "size [16, 16]": null
        });
        repair("godot_resource", "create_shape", &mut whole);
        assert_eq!(whole["size"], json!([16, 16]), "{whole}");
    }

    /// The sibling operation's words, put onto the parameters they name.
    ///
    /// `godot_scene create` takes `{path, rootType, rootName?}` and `godot_node create` takes
    /// `{parent, type, name, index}`, so a model writes the second's words into the first. Ten
    /// times across the recorded corpus — `name` five and `type` five — and those two are the only
    /// suffix-shaped misses anywhere in it. The cost is not one call each: `create` is what a turn
    /// reaches for at the *start* of building a scene, so the five `name` misses took **34
    /// operations** down with them, including a fourteen-entry call and a ten-entry one.
    #[test]
    fn a_sibling_operations_word_is_read_as_the_parameter_it_names() {
        let mut borrowed = json!({
            "path": "res://scenes/player.tscn",
            "type": "Node2D",
            "name": "Player"
        });
        repair("godot_scene", "create", &mut borrowed);
        assert_eq!(borrowed["rootType"], json!("Node2D"), "{borrowed}");
        assert_eq!(borrowed["rootName"], json!("Player"), "{borrowed}");
        check_ok("godot_scene", "create", borrowed);

        let mut too_short = json!({"path": "res://scenes/x.tscn", "rootType": "Node2D", "pe": "X"});
        repair("godot_scene", "create", &mut too_short);
        assert!(too_short.get("rootType").is_some() && too_short["rootType"] == json!("Node2D"));
        assert!(
            too_short.get("pe").is_some(),
            "two letters may not name a parameter: {too_short}"
        );
    }

    /// A blank key is shown as one, rather than as nothing at all.
    ///
    /// An `AnimationPlayer`'s default library is keyed with the empty string, so a live turn sent
    /// `{"type": "dictionary", "value": {"": …}}` and read back ``a dictionary value takes an array
    /// of {key, value} tagged pairs, and this one was an object holding .`` — true, and a sentence
    /// that stops before it says anything.
    #[test]
    fn an_object_whose_only_name_is_blank_still_says_what_it_held() {
        let blank = describe(&json!({"": 1}));
        assert_eq!(blank, "an object holding \"\"", "{blank}");
        assert_eq!(describe(&json!({"y": 1, "x": 2})), "an object holding x, y");
        assert_eq!(describe(&json!({})), "an empty object");
    }

    /// The erase entry `set_cells` documents is one the gate lets through.
    ///
    /// An entry with no `atlas` erases the cells it covers — the catalogue says so, the addon's own
    /// refusal sentence says so, and `the_addon_authors_a_whole_subtree_in_one_call`'s sibling in
    /// `godot_addon_acceptance` drives it against a real editor. None of those is the door a model
    /// comes through. This table had `atlas` required, so the one call that digs the gap Mario falls
    /// down was refused before it reached the socket, and the addon test passed the whole time
    /// because it speaks to the addon directly.
    #[test]
    fn an_entry_that_erases_carries_no_atlas_and_is_accepted() {
        check_ok(
            "godot_node",
            "set_cells",
            json!({
                "node": "/level/Terrain",
                "cells": [{"x": 10, "y": 12, "width": 2, "height": 2}]
            }),
        );
        assert!(
            message(
                "godot_node",
                "set_cells",
                json!({"node": "/level/Terrain", "cells": [{"x": 0, "y": 0, "atlas": 3}]}),
            )
            .contains("atlas"),
        );
    }

    /// A key that could only have meant one parameter is put onto it, and one that could have
    /// meant two is not.
    ///
    /// `nameSettings` for `name` is a live turn's own mistake, made nineteen times in one turn —
    /// a third of everything it did — each answered with ``Did you mean `name`?`` and each resent
    /// unchanged. `tile` is the counter-case the catalogue actually holds: `create_tileset` takes
    /// both `tileSize` and `tiles`, so `tile` names neither and stays for `check` to refuse.
    #[test]
    fn a_pair_that_tore_into_its_key_is_put_back() {
        let mut torn = json!({
            "node': '/GameLevel/Ground', ": ", ",
            "cells": [{"x": 0, "y": 0, "atlas": [0, 0]}]
        });
        repair("godot_node", "set_cells", &mut torn);
        assert_eq!(torn["node"], json!("/GameLevel/Ground"), "{torn}");
        assert!(torn.get("node': '/GameLevel/Ground', ").is_none(), "{torn}");
        check_ok("godot_node", "set_cells", torn);

        let mut two = json!({
            "parent': '/GameLevel', ": ", ",
            "type": "Node2D",
            "name": "Pickups"
        });
        repair("godot_node", "create", &mut two);
        assert_eq!(two["parent"], json!("/GameLevel"), "{two}");
        check_ok("godot_node", "create", two);

        for (op, key) in [
            ("set_cells", "node': null, "),
            ("create", "parent**: false, "),
        ] {
            let mut hopeless = json!({key.to_owned(): ", "});
            repair("godot_node", op, &mut hopeless);
            assert!(
                hopeless.get(key).is_some(),
                "{key} must not be recovered: {hopeless}"
            );
        }

        let mut elsewhere = json!({"nonesuch': '/A', ": ", "});
        repair("godot_node", "set_cells", &mut elsewhere);
        assert!(elsewhere.get("nonesuch': '/A', ").is_some(), "{elsewhere}");

        let mut held = json!({"node': '/Wrong', ": ", ", "node": "/Right",
                              "cells": [{"x": 0, "y": 0, "atlas": [0, 0]}]});
        repair("godot_node", "set_cells", &mut held);
        assert_eq!(held["node"], json!("/Right"), "{held}");

        let mut wrong_kind = json!({"index': '3', ": ", ", "parent": "/A", "type": "Node2D",
                                    "name": "N"});
        repair("godot_node", "create", &mut wrong_kind);
        assert!(wrong_kind.get("index").is_none(), "{wrong_kind}");
    }

    #[test]
    fn a_lone_value_in_a_list_comes_out_of_it() {
        let mut boxed = json!({"node": ["/Player"], "group": "players"});
        repair("godot_node", "add_to_group", &mut boxed);
        assert_eq!(boxed, json!({"node": "/Player", "group": "players"}));
        check_ok("godot_node", "add_to_group", boxed);

        let mut two = json!({"node": ["/A", "/B"], "group": "players"});
        repair("godot_node", "add_to_group", &mut two);
        assert_eq!(two["node"], json!(["/A", "/B"]), "{two}");
        assert!(message("godot_node", "add_to_group", two).contains("`node`"));

        let mut wrong = json!({"node": [7], "group": "players"});
        repair("godot_node", "add_to_group", &mut wrong);
        assert_eq!(wrong["node"], json!([7]), "{wrong}");

        let mut listed = json!({"path": ["res://a.png"]});
        repair("godot_resource", "rescan", &mut listed);
        assert_eq!(listed["path"], json!(["res://a.png"]), "{listed}");
        check_ok("godot_resource", "rescan", listed);

        let mut nested = json!({
            "properties": [{"node": ["/Player"], "property": "position",
                            "value": {"type": "vector2", "value": [1, 2]}}]
        });
        repair("godot_node", "set_properties", &mut nested);
        assert_eq!(
            nested["properties"][0]["node"],
            json!("/Player"),
            "{nested}"
        );
    }

    #[test]
    fn a_key_that_can_only_have_meant_one_parameter_is_put_onto_it() {
        let mut written = json!({
            "nameSettings": "SettingsManager",
            "path": "res://scripts/settings_manager.gd",
            "enabled": true
        });
        repair("godot_project", "set_autoload", &mut written);
        assert_eq!(
            written,
            json!({
                "name": "SettingsManager",
                "path": "res://scripts/settings_manager.gd",
                "enabled": true
            })
        );
        check_ok("godot_project", "set_autoload", written);

        let mut ambiguous = json!({"path": "res://t.tres", "texture": "res://t.png", "tile": 16});
        repair("godot_resource", "create_tileset", &mut ambiguous);
        assert_eq!(ambiguous["tile"], json!(16), "{ambiguous}");
        assert!(
            message("godot_resource", "create_tileset", ambiguous).contains("`tile`"),
            "an ambiguous key is still refused by name"
        );

        let mut both = json!({"name": "Real", "nameSettings": "Other", "path": "res://a.gd"});
        repair("godot_project", "set_autoload", &mut both);
        assert_eq!(both["name"], json!("Real"));
        assert_eq!(both["nameSettings"], json!("Other"));

        let mut colon = json!({"line": 13});
        colon["path:"] = json!("scripts/main.gd");
        repair("godot_debug", "breakpoint_locations", &mut colon);
        assert_eq!(colon["path"], json!("scripts/main.gd"), "{colon}");
        check_ok("godot_debug", "breakpoint_locations", colon);

        let mut torn = json!({"signal": "coin_collected", "binds": []});
        torn["method\": \"_on_coin_collected\", "] = json!(", ");
        repair("godot_node", "connect_signal", &mut torn);
        assert_eq!(torn["method"], json!("_on_coin_collected"), "{torn}");
        assert!(
            torn.get("method\": \"_on_coin_collected\", ").is_none(),
            "{torn}"
        );

        let mut numeric = json!({"expression": "velocity"});
        numeric["frameId': 0}, {"] = json!(": 0}]}]'</parameter></function>");
        repair("godot_debug", "evaluate", &mut numeric);
        assert_eq!(numeric["frameId"], json!(0), "{numeric}");
        check_ok("godot_debug", "evaluate", numeric);

        let typo = json!({"nameSettings": "A", "path": "res://a.gd", "name": "Taken"});
        let hinted = message("godot_project", "set_autoload", typo);
        assert!(hinted.contains("Did you mean `name`?"), "{hinted}");
        assert!(!hinted.contains("It arrived carrying"), "{hinted}");

        let mut contested = json!({"nameSettings": "A", "nameOfIt": "B", "path": "res://a.gd"});
        repair("godot_project", "set_autoload", &mut contested);
        assert_eq!(contested["nameSettings"], json!("A"), "{contested}");
        assert_eq!(contested["nameOfIt"], json!("B"), "{contested}");
        assert!(contested.get("name").is_none(), "{contested}");

        let mut nested = json!({
            "files": [{"pathName": "scripts/a.gd", "edits": [{"oldText": "a", "newText": "b"}]}]
        });
        repair("godot_script", "edit", &mut nested);
        assert_eq!(nested["files"][0]["path"], json!("scripts/a.gd"));
        check_ok("godot_script", "edit", nested);
    }

    /// The failure this whole module exists for. The old answer was
    /// `A resource value requires an object carrying a path`, which a model read eight times
    /// without changing anything, because it never showed the wrapper or repeated the path.
    #[test]
    fn a_resource_written_as_a_string_is_answered_with_the_corrected_call() {
        let refused = message(
            "godot_node",
            "set_property",
            json!({
                "node": "/Player",
                "property": "script",
                "value": {"type": "resource", "value": "res://scripts/player.gd"},
                "expectedRevision": 1
            }),
        );
        assert!(
            refused.contains(
                "Send {\"type\": \"resource\", \"value\": {\"path\": \"res://scripts/player.gd\"}}."
            ),
            "the correction must carry the model's own path: {refused}"
        );
        assert!(
            refused.contains("the string \"res://scripts/player.gd\""),
            "the failure must repeat what arrived: {refused}"
        );
    }

    /// The call a live turn actually wrote: five files, each nested inside the previous file's
    /// `edits` instead of standing beside it in `files`. It was answered `missing field oldText`,
    /// which names no operation, no parameter and no position — serde was the first thing to look
    /// inside a `list`, because the kind stops at the outermost bracket.
    #[test]
    fn a_nested_entry_is_refused_where_it_sits_rather_than_by_serde() {
        let refused = message(
            "godot_script",
            "edit",
            json!({
                "files": [{
                    "path": "scripts/game.gd",
                    "edits": [
                        {"oldText": "old", "newText": "new"},
                        {"path": "scripts/enemy.gd", "edits": [{"oldText": "a", "newText": "b"}]}
                    ]
                }]
            }),
        );
        assert!(
            refused.contains("`files[0].edits[1]` has no `edits` key"),
            "the failure must name the entry that is wrong: {refused}"
        );
        assert!(
            refused.contains("{oldText: text, newText: text}"),
            "the failure must show what an entry takes: {refused}"
        );
    }

    /// `apply_rename` takes the same parameter name as `edit` and a different shape behind it, and
    /// for a while it declared no shape at all. Nothing checked it: the schema widened to a bare
    /// list that swallowed `edit`'s strict branch, and [`check_inside`] returns early on an empty
    /// entry — so `{"nope": 1}` was accepted by both layers and serde was the first thing to look.
    ///
    /// That is the refusal [`check_inside`] exists to replace, so the entry is declared and this
    /// holds it. `scripts/check-command-surface.mjs` refuses the omission returning.
    #[test]
    fn a_rename_plan_is_checked_rather_than_waved_through() {
        check_ok(
            "godot_script",
            "apply_rename",
            json!({"files": [{
                "path": "a.gd",
                "originalText": "x",
                "originalHash": "h",
                "updatedText": "y"
            }]}),
        );
        let refused = message(
            "godot_script",
            "apply_rename",
            json!({"files": [{"nope": 1}]}),
        );
        assert!(
            refused.contains("`files[0]`"),
            "the failure must name the entry that is wrong: {refused}"
        );
        let partial = message(
            "godot_script",
            "apply_rename",
            json!({"files": [{"path": "a.gd", "originalText": "x", "originalHash": "h"}]}),
        );
        assert!(
            partial.contains("requires `updatedText`"),
            "a plan missing a field must say which: {partial}"
        );
    }

    /// `set_input_action` takes the same `events` name `runtime.input` takes in another domain,
    /// and for a while it declared no shape at all: the schema advertised a bare list and
    /// [`check_inside`] returns early on one, so `{"nope": 1}` crossed the socket and the
    /// editor's decoder was the first thing to look. The editor's decoder takes three kinds —
    /// the game's takes five — so the entry names the three, and this holds them.
    #[test]
    fn an_input_action_event_is_checked_rather_than_waved_through() {
        check_ok(
            "godot_project",
            "set_input_action",
            json!({"name": "move_left", "events": [
                {"kind": "key", "key": "Left"},
                {"kind": "mouse_button", "button": 1},
                {"kind": "joypad_button", "button": 5}
            ]}),
        );
        let refused = message(
            "godot_project",
            "set_input_action",
            json!({"name": "move_left", "events": [{"nope": 1}]}),
        );
        assert!(
            refused.contains("`events[0]`"),
            "the failure must name the entry that is wrong: {refused}"
        );
        let partial = message(
            "godot_project",
            "set_input_action",
            json!({"name": "jump", "events": [{"key": "Space"}]}),
        );
        assert!(
            partial.contains("requires `kind`"),
            "an event missing its kind must say which: {partial}"
        );
    }

    /// The nesting is printed as deeply as it goes, because the signature is where a model reads
    /// the contract — the same measurement that put kinds there in the first place.
    #[test]
    fn the_signature_carries_the_shape_inside_a_list() {
        assert_eq!(
            signature(params_of("godot_script", "edit").expect("edit declares its parameters")),
            "{files: list of {path: text, edits: list of {oldText: text, newText: text}}}"
        );
    }

    /// A list of one scalar kind says so, and refuses an entry that is not one, by position.
    ///
    /// `entry` can only say what an *object* entry holds, so `properties: list` was the whole of
    /// what `node.inspect` could have declared — and a name that means a list of objects in one
    /// operation of a domain and a bare list in another widens the generated schema to an array
    /// that swallows the strict branch. `everyMergedNameDeclaresItsShape` refuses that outright,
    /// so a list of strings had no way to be declared beside `set_properties`' list of objects.
    #[test]
    fn a_list_of_one_kind_says_which_and_refuses_the_entry_that_is_not_it() {
        assert_eq!(
            signature(params_of("godot_node", "inspect").expect("inspect declares its parameters")),
            "{node: text, properties?: list of text}"
        );
        check_ok(
            "godot_node",
            "inspect",
            json!({"node": "/Main/Label", "properties": ["text", "position"]}),
        );
        check_ok("godot_node", "inspect", json!({"node": "/Main/Label"}));

        let refused = message(
            "godot_node",
            "inspect",
            json!({"node": "/Main/Label", "properties": ["text", {"name": "position"}]}),
        );
        assert!(
            refused.contains("properties[1]") && refused.contains("a string"),
            "the entry that is not a string must be named by its position: {refused}"
        );
        assert!(
            message(
                "godot_node",
                "inspect",
                json!({"node": "/x", "properties": "text"})
            )
            .contains("a list of a string"),
            "a list of strings written as one string must be refused"
        );
    }

    #[test]
    fn an_entry_shape_accepts_the_call_it_describes() {
        check_ok(
            "godot_script",
            "edit",
            json!({"files": [{"path": "a.gd", "edits": [{"oldText": "x", "newText": "y"}]}]}),
        );
        check_ok(
            "godot_node",
            "set_properties",
            json!({
                "properties": [
                    {"node": "/Player", "property": "position",
                     "value": {"type": "vector2", "value": [1, 2]}}
                ],
                "expectedRevision": 3
            }),
        );
        let refused = message(
            "godot_node",
            "set_properties",
            json!({
                "properties": [{"node": "/Player", "property": "script",
                                "value": {"type": "resource", "value": "res://a.gd"}}]
            }),
        );
        assert!(
            refused.contains("`properties[0].value`"),
            "a tagged value inside a list must name its position: {refused}"
        );
    }

    #[test]
    fn the_shape_the_addon_accepts_is_the_shape_this_accepts() {
        check_ok(
            "godot_node",
            "set_property",
            json!({
                "node": "/Player",
                "property": "script",
                "value": {"type": "resource", "value": {"path": "res://scripts/player.gd"}},
                "expectedRevision": 1
            }),
        );
        check_ok(
            "godot_node",
            "set_property",
            json!({
                "node": "/Player/Sprite2D",
                "property": "region_rect",
                "value": {"type": "rect2", "value": [112, 0, 16, 16]},
                "expectedRevision": 2
            }),
        );
    }

    #[test]
    fn a_missing_parameter_names_itself_and_the_whole_shape() {
        let refused = message(
            "godot_node",
            "set_property",
            json!({"node": "/Player", "value": {"type": "int", "value": 1}, "expectedRevision": 1}),
        );
        assert!(refused.contains("requires `property`"), "{refused}");
        assert!(
            refused.contains("{node: text, property: text, value: tagged}"),
            "{refused}"
        );
        assert!(
            refused.contains("This one carries expectedRevision, node, value."),
            "{refused}"
        );
    }

    #[test]
    fn a_missing_parameter_names_what_did_arrive() {
        let pathless = message(
            "godot_script",
            "edit",
            json!({"files": [{"edits": [{"oldText": "var a := 1", "newText": "var a := 2"}]}]}),
        );
        assert!(
            pathless.contains("`files[0]` requires `path`"),
            "{pathless}"
        );
        assert!(pathless.contains("This one carries edits."), "{pathless}");

        let empty = message("godot_script", "edit", json!({"files": [{}]}));
        assert!(empty.contains("This one is empty."), "{empty}");

        let mut wide = serde_json::Map::new();
        for index in 0..13 {
            wide.insert(format!("k{index:02}"), json!(1));
        }
        let counted = super::what_it_carries(&wide);
        assert!(counted.contains("and 5 more."), "{counted}");

        let mut torn = serde_json::Map::new();
        torn.insert("x".repeat(120), json!(1));
        let cut = super::what_it_carries(&torn);
        assert!(cut.contains('…'), "{cut}");
        assert!(!cut.contains(&"x".repeat(120)), "{cut}");
    }

    #[test]
    fn a_name_that_is_not_accepted_is_refused_with_the_nearest_one() {
        let refused = message(
            "godot_node",
            "create",
            json!({
                "parent": "/Level",
                "type": "Sprite2D",
                "name": "Coin",
                "nodeIndex": 2,
                "expectedRevision": 1
            }),
        );
        assert!(
            refused.contains("has no `nodeIndex` parameter"),
            "{refused}"
        );
    }

    #[test]
    fn a_wrong_arity_names_the_count_it_wanted() {
        let refused = message(
            "godot_node",
            "set_property",
            json!({
                "node": "/Player",
                "property": "position",
                "value": {"type": "vector2", "value": [12]},
                "expectedRevision": 1
            }),
        );
        assert!(refused.contains("an array of 2 numbers"), "{refused}");
    }

    /// The shape the correction could not stop, repaired instead.
    ///
    /// Every value here was written by a live turn against a local Qwen3.6-27B driving a real
    /// editor: a vector2 and a float on `set_property`, a vector2 inside `set_properties`.
    #[test]
    fn a_vector_written_as_an_object_is_repaired_before_it_is_checked() {
        let mut one = json!({
            "node": "/Main/Player",
            "property": "position",
            "value": {"type": "vector2", "value": {"x": 32, "y": 48}}
        });
        repair("godot_node", "set_property", &mut one);
        assert_eq!(one["value"], json!({"type": "vector2", "value": [32, 48]}));
        assert!(check("godot_node", "set_property", &one).is_ok());

        let mut listed = json!({
            "properties": [
                {
                    "node": "/Main/Floor",
                    "property": "position",
                    "value": {"type": "vector2", "value": {"x": 0, "y": -100}}
                },
                {
                    "node": "/Main/Floor",
                    "property": "visible",
                    "value": {"type": "bool", "value": true}
                }
            ]
        });
        repair("godot_node", "set_properties", &mut listed);
        assert_eq!(
            listed["properties"][0]["value"],
            json!({"type": "vector2", "value": [0, -100]})
        );
        assert_eq!(
            listed["properties"][1]["value"],
            json!({"type": "bool", "value": true})
        );
        assert!(check("godot_node", "set_properties", &listed).is_ok());

        let mut colour = json!({
            "node": "/Main/Player",
            "property": "modulate",
            "value": {"type": "color", "value": {"r": 1, "g": 0.5, "b": 0.25, "a": 1}}
        });
        repair("godot_node", "set_property", &mut colour);
        assert_eq!(
            colour["value"],
            json!({"type": "color", "value": [1, 0.5, 0.25, 1]})
        );
    }

    /// The kind word, written back into the value.
    ///
    /// A model that reads `value: tagged` and the kind beside it wrote
    /// `{"type": "float", "value": {"number": 3.5}}` and `{"type": "string", "value": {"text": …}}`
    /// eight times in one live turn — the protocol's own words for those kinds, used as a key.
    #[test]
    fn a_scalar_written_in_a_box_is_taken_out_of_it() {
        let boxed = |value: Value| {
            let mut written =
                json!({"node": "/Main/Player", "property": "rotation", "value": value});
            repair("godot_node", "set_property", &mut written);
            written["value"].clone()
        };
        assert_eq!(
            boxed(json!({"type": "float", "value": {"number": 3.5}})),
            json!({"type": "float", "value": 3.5})
        );
        assert_eq!(
            boxed(json!({"type": "string", "value": {"text": "Coin"}})),
            json!({"type": "string", "value": "Coin"})
        );
        assert_eq!(
            boxed(json!({"type": "bool", "value": {"value": true}})),
            json!({"type": "bool", "value": true})
        );

        for wrong in [
            json!({"type": "float", "value": {"number": 3.5, "unit": "degrees"}}),
            json!({"type": "float", "value": {"number": "3.5"}}),
        ] {
            assert_eq!(boxed(wrong.clone()), wrong);
        }
    }

    /// Everything the table cannot order is left exactly as it arrived, for `check` to refuse.
    ///
    /// The same run wrote `an object holding x` for a float and `an object holding origin, x, y`
    /// for a transform2d. Neither is a vector written under names; both are the model inventing a
    /// shape, and a guess at what it meant would be worse than the sentence that names it.
    #[test]
    fn a_value_nobody_can_order_is_left_for_the_refusal_to_name() {
        for (property, value) in [
            (
                "transform",
                json!({"type": "transform2d", "value": {"origin": [0, 0], "x": [1, 0], "y": [0, 1]}}),
            ),
            (
                "rect",
                json!({"type": "rect2", "value": {"top": 0, "left": 1, "width": 2, "height": 3}}),
            ),
        ] {
            let mut written = json!({"node": "/Main/Player", "property": property, "value": value});
            let before = written.clone();
            repair("godot_node", "set_property", &mut written);
            assert_eq!(written, before, "{property}");
            assert!(
                check("godot_node", "set_property", &written).is_err(),
                "{property}"
            );
        }

        let mut right = json!({
            "node": "/Main/Player",
            "property": "script",
            "value": {"type": "resource", "value": {"path": "res://scripts/player.gd"}}
        });
        let before = right.clone();
        repair("godot_node", "set_property", &mut right);
        assert_eq!(right, before);
    }

    /// A live run wrote `{"x": 32, "y": 32}` for a vector2 thirteen times and was refused thirteen
    /// times. The sentence said what was wanted and never what to send, so the numbers it already
    /// had were never handed back to it in the right shape.
    ///
    /// An agent call no longer reaches this: [`repair`] runs first and the value is already an
    /// array by the time `check` sees it. The sentence is still what the renderer and the addon's
    /// own backstop answer with, and it is still what a shape the repair declines comes back as.
    #[test]
    fn a_vector_written_as_an_object_is_refused_with_the_value_it_should_have_sent() {
        let refused = message(
            "godot_node",
            "set_property",
            json!({
                "node": "/Player",
                "property": "position",
                "value": {"type": "vector2", "value": {"x": 32, "y": 48}}
            }),
        );
        assert!(refused.contains("an object holding x, y"), "{refused}");
        assert!(
            refused.contains(r#"Send {"type": "vector2", "value": [32, 48]}"#),
            "{refused}"
        );

        let colour = message(
            "godot_node",
            "set_property",
            json!({
                "node": "/Player",
                "property": "modulate",
                "value": {"type": "color", "value": {"r": 1, "g": 0.5, "b": 0.25, "a": 1}}
            }),
        );
        assert!(
            colour.contains(r#"Send {"type": "color", "value": [1, 0.5, 0.25, 1]}"#),
            "{colour}"
        );
    }

    /// Only where the order is not a guess. Four numbers under four names that are not a colour or
    /// a vector could be a rect2 in either order, so nothing is offered rather than the wrong thing.
    #[test]
    fn numbers_under_names_nobody_can_order_are_left_without_a_correction() {
        let refused = message(
            "godot_node",
            "set_property",
            json!({
                "node": "/Player",
                "property": "rect",
                "value": {"type": "rect2", "value": {"top": 0, "left": 1, "width": 2, "height": 3}}
            }),
        );
        assert!(refused.contains("an array of 4 numbers"), "{refused}");
        assert!(!refused.contains("Send {"), "{refused}");
    }

    /// `godot_scene reload` declares one parameter and it is hidden, so its signature is empty and
    /// the sentence read `It takes .` — which is what a live run was sent.
    #[test]
    fn an_operation_with_nothing_to_take_says_so_rather_than_trailing_off() {
        let refused = message("godot_scene", "reload", json!({"scene": "res://main.tscn"}));
        assert!(refused.contains("It takes no parameters."), "{refused}");
        assert!(!refused.contains("It takes ."), "{refused}");
    }

    /// The near miss must not point at a parameter the prompt tells the model never to pass. A live
    /// run wrote a key that was not one at all and was answered `Did you mean `expectedRevision`?`.
    #[test]
    fn the_nearest_name_is_never_one_the_model_is_told_not_to_send() {
        let refused = message(
            "godot_node",
            "create",
            json!({
                "parent": "/Level",
                "type": "Sprite2D",
                "name": "Coin",
                "expectedRevisio": 1
            }),
        );
        assert!(refused.contains("has no `expectedRevisio`"), "{refused}");
        assert!(!refused.contains("Did you mean"), "{refused}");
    }

    #[test]
    fn a_tag_that_does_not_exist_lists_the_ones_that_do() {
        let refused = message(
            "godot_project",
            "set_setting",
            json!({"name": "display/window/size/viewport_width", "value": {"type": "number", "value": 1152}}),
        );
        assert!(
            refused.contains("`number` is not a value type"),
            "{refused}"
        );
        assert!(refused.contains("vector2"), "{refused}");
    }

    #[test]
    fn a_bare_value_where_a_tagged_one_belongs_shows_the_tag() {
        let refused = message(
            "godot_project",
            "set_setting",
            json!({"name": "display/window/size/viewport_width", "value": 1152}),
        );
        assert!(refused.contains("a tagged value like"), "{refused}");
        assert!(refused.contains("the number 1152"), "{refused}");
    }

    #[test]
    fn timeout_is_accepted_everywhere_without_being_declared() {
        check_ok("godot_scene", "get_tree", json!({"timeoutMs": 5_000}));
    }

    /// An operation with no table is unchecked, and that has to stay visible: absence must never be
    /// read as "this operation takes nothing".
    #[test]
    fn an_operation_without_a_table_is_not_refused() {
        check_ok("godot_script", "open", json!({"path": "scripts/mario.gd"}));
        check_ok("godot_node", "set_property", json!("not an object"));
    }

    /// The whole catalogue, with no exceptions list.
    ///
    /// The first cut of this file covered four domains and left five to serde, which read as a
    /// reasonable division and was not one: `expectedHash` lives in one of the five, a model
    /// copied sixty-three of its sixty-four characters, and nothing between it and the filesystem
    /// counted them. A schema with a hole in it is not a schema, so there is no hole and no way to
    /// add one — an operation reaches the model only through `CATALOG`, and every entry of it has
    /// to be declared here.
    ///
    /// It cannot be missed any more: an operation *is* one of these rows, so there is no second
    /// list to add one to. What is left to check is that the row says something — a row reaching
    /// the model with no prose is an operation it is told the name of and nothing else, which is
    /// the one thing this catalogue may not be.
    #[test]
    fn every_catalog_operation_declares_its_parameters() {
        let mute: Vec<String> = CATALOG
            .iter()
            .flat_map(|domain| {
                domain
                    .operations
                    .iter()
                    .filter(|operation| {
                        params_of(domain.name, operation.op).is_none()
                            || operation.summary.trim().is_empty()
                    })
                    .map(move |operation| format!("{} {}", domain.name, operation.op))
            })
            .collect();
        assert!(
            mute.is_empty(),
            "these operations reach the model with no contract and nothing said about them:\n{}",
            mute.join("\n")
        );
    }

    /// Every declared operation is offered by the domain it names, so a domain cannot be handed
    /// another domain's rows.
    ///
    /// A list nobody hands to a domain at all is a dead const rather than a test failure: only
    /// `CATALOG` names one, so the compiler reports it. What a compiler cannot see is a domain
    /// handed the wrong list — every row would still be a real row, checked against a real
    /// parameter table, under a tool that does not offer it.
    #[test]
    fn no_table_outlives_the_operation_it_declares() {
        for domain in CATALOG {
            assert!(
                !domain.operations.is_empty(),
                "{} offers nothing",
                domain.name
            );
            for operation in domain.operations {
                assert_eq!(
                    operation.tool, domain.name,
                    "{} was handed {}'s {} row",
                    domain.name, operation.tool, operation.op
                );
            }
        }
    }

    /// A hash is sixty-four lowercase hex characters, and one character short is a typo rather
    /// than a file that changed. This is the check the live run needed and did not have.
    #[test]
    fn a_hash_one_character_short_is_refused_as_a_copy_that_slipped() {
        let full = "a".repeat(64);
        check_ok(
            "godot_script",
            "save",
            json!({"path": "hud.gd", "text": "extends Node2D\n", "expectedHash": full}),
        );
        let short = "a".repeat(63);
        let refused = message(
            "godot_script",
            "save",
            json!({"path": "hud.gd", "text": "extends Node2D\n", "expectedHash": short}),
        );
        assert!(refused.contains("63 characters"), "{refused}");
        assert!(refused.contains("Copy it again"), "{refused}");
        assert!(
            !refused.contains("changed"),
            "a mistyped hash must not be blamed on the file: {refused}"
        );

        let wrong = format!("{}Z", "a".repeat(63));
        assert!(
            check(
                "godot_resource",
                "delete",
                &json!({"path": "a.gd", "expectedHash": wrong})
            )
            .is_err(),
            "sixty-four characters is not enough to be a hash"
        );
    }

    /// `either` accepts each of its kinds and nothing else.
    #[test]
    fn a_parameter_of_two_kinds_takes_either_and_no_third() {
        for size in [json!(16), json!([16, 16])] {
            check_ok(
                "godot_resource",
                "create_tileset",
                json!({"path": "a.tres", "texture": "t.png", "tileSize": size}),
            );
        }
        let refused = message(
            "godot_resource",
            "create_tileset",
            json!({"path": "a.tres", "texture": "t.png", "tileSize": "16"}),
        );
        assert!(refused.contains("a number or an array"), "{refused}");
    }

    /// The signature is what the model reads, so it has to say which parameters are optional — and
    /// leave out the ones the router fills in, which a model that reads it will otherwise try to
    /// supply.
    #[test]
    fn the_signature_marks_the_optional_parameters() {
        let params = params_of("godot_node", "create").expect("node.create is in the table");
        assert_eq!(
            signature(params),
            "{parent: text, type: text, name: text, index?: int}"
        );
        assert_eq!(signature(&[]), "");
    }

    /// A tagged value wrapped in a second copy of its own tag, unwrapped rather than refused.
    ///
    /// One live turn against a local Qwen3.6-27B sent 51 of these in 114 tool calls, and every one
    /// was refused by a sentence that named the shape it wanted and never noticed that the shape it
    /// wanted was sitting inside the one it got.
    ///
    /// This lived in the worker until it was moved here. It was the only place a live turn's
    /// commonest wrong shape was repaired, and the acceptance suites — which call `dispatch`
    /// directly — never ran it at all.
    #[test]
    fn a_tag_written_twice_is_unwrapped_rather_than_refused() {
        let repaired = |value: Value| {
            let mut params = json!({"node": "/Player", "property": "position", "value": value});
            repair("godot_node", "set_property", &mut params);
            params["value"].clone()
        };

        assert_eq!(
            repaired(json!({"type": "vector2", "value": {"type": "vector2", "value": [32, 48]}})),
            json!({"type": "vector2", "value": [32, 48]})
        );

        for wrapper in [
            json!({"type": "string", "value": {"type": "String", "value": "Resume"}}),
            json!({"type": "String", "value": {"type": "string", "value": "Resume"}}),
        ] {
            assert_eq!(
                repaired(wrapper.clone()),
                json!({"type": "string", "value": "Resume"}),
                "{wrapper}"
            );
        }

        assert_eq!(
            repaired(json!({"type": "String", "value": "Resume"})),
            json!({"type": "string", "value": "Resume"})
        );

        assert_eq!(
            repaired(json!({
                "type": "int",
                "value": {"type": "int", "value": {"type": "int", "value": 2}}
            })),
            json!({"type": "int", "value": 2})
        );

        for left in [
            json!({"type": "vector2", "value": {"type": "float", "value": 1}}),
            json!({"type": "int", "value": {"type": "float", "value": 1}}),
            json!({"type": "Vektor2", "value": [1, 2]}),
            json!({"type": "resource", "value": {"path": "res://scripts/player.gd"}}),
        ] {
            assert_eq!(repaired(left.clone()), left, "{left}");
        }

        let mut listed = json!({"properties": [
            {"node": "/P", "property": "position",
             "value": {"type": "vector2", "value": {"type": "vector2", "value": [1, 2]}}},
            {"node": "/P", "property": "visible", "value": {"type": "bool", "value": true}},
        ]});
        repair("godot_node", "set_properties", &mut listed);
        assert_eq!(
            listed["properties"][0]["value"],
            json!({"type": "vector2", "value": [1, 2]}),
            "{listed}"
        );
        assert_eq!(
            listed["properties"][1]["value"],
            json!({"type": "bool", "value": true}),
            "{listed}"
        );
        check_ok("godot_node", "set_properties", listed);
    }

    /// The shape the fixture says a recorded call has to be repaired into is the shape `check`
    /// accepts, proven rather than maintained by hand.
    ///
    /// `fixtures/recorded-tool-calls.json` carries nine calls under `repairs` that a model really
    /// wrote and the router really refused, each beside the `repaired` form it had to become. That
    /// field used to be asserted only against the worker's normalizer, in JavaScript, in another
    /// process — so if it drifted from what this file accepts, both tests stayed green and the live
    /// call was still refused.
    ///
    /// So the fixture is run down the path the router really takes: repair, then check. Three
    /// things have to hold for every entry, and the third is what keeps this from being vacuous —
    /// the call as the model wrote it has to be one `check` refuses, or the fixture is recording a
    /// repair that does nothing.
    #[test]
    fn every_shape_the_fixture_records_as_repaired_is_the_shape_the_router_accepts() {
        let recorded: Value = serde_json::from_slice(
            &std::fs::read(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../fixtures/recorded-tool-calls.json"),
            )
            .expect("read the recorded calls"),
        )
        .expect("parse the recorded calls");
        let repairs = recorded["repairs"].as_array().expect("recorded repairs");
        assert!(repairs.len() > 5, "the fixture lost its repairs");

        let without_op = |entry: &Value| {
            let mut params = entry.clone();
            if let Some(object) = params.as_object_mut() {
                object.remove("op");
            }
            params
        };
        for case in repairs {
            let tool = case["tool"].as_str().expect("case tool");
            let written = case["ops"].as_array().expect("case ops");
            let wanted = case["repaired"].as_array().expect("case repaired");
            assert_eq!(
                written.len(),
                wanted.len(),
                "{tool} records {} calls and {} repairs of them",
                written.len(),
                wanted.len()
            );
            let mut refused_as_written = 0;
            for (entry, want) in written.iter().zip(wanted) {
                let op = entry["op"].as_str().expect("an op name");
                assert_eq!(
                    want["op"].as_str(),
                    Some(op),
                    "{tool} records a repair of another operation"
                );
                let mut params = without_op(entry);
                if check(tool, op, &params).is_err() {
                    refused_as_written += 1;
                }
                repair(tool, op, &mut params);
                assert_eq!(
                    params,
                    without_op(want),
                    "{tool} {op} was repaired into a shape the fixture does not name"
                );
                check(tool, op, &params).unwrap_or_else(|failure| {
                    panic!("{tool} {op} is refused after repair: {}", failure.message)
                });
            }
            assert!(
                refused_as_written > 0,
                "{tool} records a repair of a call nothing was going to refuse"
            );
        }
    }

    /// Three coins written as one torn entry earn one refusal, not one per key.
    ///
    /// The exact object a live turn sent, from `runs/coin01`: the model wrote three `instantiate`
    /// entries, its JSON tore across all three, and what arrived was one entry holding an intact
    /// `op`, `parent` and `path` beside three keys made of the wreckage. Gofer answered about one
    /// key per refusal — `nameCoin1` first, with `Did you mean `name`?` — and the model spent five
    /// round trips and 3.6k tokens peeling them off one at a time, then abandoned the batch and
    /// instantiated the coins one call at a time, which worked.
    ///
    /// A spelling hint is the wrong advice for wreckage, so this refusal withholds it.
    #[test]
    fn an_entry_that_came_apart_in_three_places_is_refused_once() {
        let mut entry = serde_json::Map::new();
        entry.insert("parent".to_owned(), json!("/Main"));
        entry.insert("path".to_owned(), json!("res://scenes/coin.tscn"));
        entry.insert("nameCoin1".to_owned(), Value::Null);
        entry.insert("name\": \"Coin1\"}, {".to_owned(), Value::Null);
        entry.insert(
            "path\": \"res://scenes/coin.tscn\", ".to_owned(),
            json!(", \"Coin2\"}, {"),
        );
        let refused = check("godot_node", "instantiate", &Value::Object(entry))
            .expect_err("the entry is refused");
        assert_eq!(refused.code, "torn_param", "{}", refused.message);
        assert!(
            refused.message.contains("3 keys it does not take"),
            "it counts the wreckage rather than naming one piece of it: {}",
            refused.message
        );
        assert!(
            refused.message.contains("came apart"),
            "it says the object came apart: {}",
            refused.message
        );
        assert!(
            !refused.message.contains("Did you mean"),
            "a spelling hint sends a model looking for a better word for wreckage: {}",
            refused.message
        );
        assert!(
            refused.message.contains("carries parent, path"),
            "it names the keys that survived: {}",
            refused.message
        );
        assert!(refused.message.contains("cut off"), "{}", refused.message);
        assert!(
            refused.message.contains("fewer operations"),
            "{}",
            refused.message
        );
    }

    /// One wrong word is still one wrong word.
    ///
    /// The refusal above must not swallow the ordinary case: a single misspelled parameter still
    /// earns the near-miss hint, which is what a model can act on in one round trip.
    #[test]
    fn a_single_misspelled_parameter_still_gets_its_near_miss() {
        let refused = check(
            "godot_node",
            "instantiate",
            &json!({"parent": "/Main", "pathh": "res://a.tscn"}),
        )
        .expect_err("the call is refused");
        assert_eq!(refused.code, "unknown_param", "{}", refused.message);
        assert!(
            refused.message.contains("Did you mean `path`?"),
            "{}",
            refused.message
        );
    }

    /// A tagged value written as two flat keys is one value, not two candidate names.
    ///
    /// Both shapes a live turn wrote for `create_shape`'s `size`, and both were refused with
    /// ``has no `sizeType` parameter … Did you mean `size`?`` — a hint naming the half that was
    /// already right. Nothing about `size` is tagged; the habit came from `set_property`.
    ///
    /// Measured against the local Qwen3.8-27B at medium: 0 of 8 entries carried a well-formed
    /// `size`, over two catalogue arms. See `fold_a_tag_written_flat`.
    #[test]
    fn a_tagged_value_flattened_onto_a_parameter_name_is_folded_back() {
        for written in [
            json!({
                "path": "a.tres", "shapeType": "RectangleShape2D",
                "sizeType": Value::Null, "sizeValue": [24, 48]
            }),
            json!({
                "path": "a.tres", "shapeType": "RectangleShape2D",
                "sizeType": "Vector2", "sizeValue": [24, 48]
            }),
            json!({
                "path": "a.tres", "shapeType": "RectangleShape2D",
                "size_type": "Vector2", "size_value": [24, 48]
            }),
        ] {
            let mut held = written.clone();
            repair("godot_resource", "create_shape", &mut held);
            assert_eq!(held["size"], json!([24, 48]), "{written} became {held}");
            check_ok("godot_resource", "create_shape", held);
        }

        let mut lone = json!({"path": "a.tres", "shapeType": "CircleShape2D", "radiusValue": 8});
        repair("godot_resource", "create_shape", &mut lone);
        assert_eq!(lone["radius"], json!(8), "{lone}");

        let mut alone = json!({
            "path": "a.tres", "shapeType": "RectangleShape2D", "sizeType": "Vector2"
        });
        repair("godot_resource", "create_shape", &mut alone);
        assert_eq!(alone["sizeType"], json!("Vector2"), "{alone}");
        let refused =
            check("godot_resource", "create_shape", &alone).expect_err("the key is named");
        assert!(
            refused.message.contains("`sizeType`"),
            "{}",
            refused.message
        );

        let mut carried = json!({
            "path": "a.tres", "shapeType": "SegmentShape2D",
            "pointsType": [0, 0], "pointsValue": [0, 0, 8, 8]
        });
        repair("godot_resource", "create_shape", &mut carried);
        assert_eq!(carried["pointsType"], json!([0, 0]), "{carried}");
    }

    /// A key with nothing in it must not block the key that holds the answer.
    ///
    /// The call a live turn sent `resource.create_shape` while building a tile level. `size_list`
    /// alone is renamed to `size` and runs; the empty key beside it made both read as `size`, the
    /// rename refused a contest it could not resolve, and the call came back
    /// ``has no `size_list` parameter … Did you mean `size`?`` — about the key that was closest to
    /// right.
    #[test]
    fn an_empty_key_does_not_block_the_one_beside_it() {
        let mut held = json!({
            "path": "assets/player_shape.tres",
            "shapeType": "RectangleShape2D",
            "size_list": [16, 16],
            "size_list_note": Value::Null
        });
        repair("godot_resource", "create_shape", &mut held);
        assert_eq!(held["size"], json!([16, 16]), "{held}");
        check_ok("godot_resource", "create_shape", held);

        let mut contested = json!({
            "path": "a.tres", "shapeType": "RectangleShape2D",
            "size_a": [16, 16], "size_b": [32, 32]
        });
        repair("godot_resource", "create_shape", &mut contested);
        assert!(contested.get("size").is_none(), "{contested}");
    }

    /// A rename never lands a value on a parameter that could not have held it.
    ///
    /// The call a live turn sent while building a platformer, both entries the same shape:
    /// `{"size_list": [16, 16], "height_list": [16, 16]}`. Both keys are name-shaped and each reads
    /// as exactly one parameter, so both were renamed — `size` correctly, and `height`, which is a
    /// number, onto a pair. The whole call came back ``\`height\` takes a number, and this one was
    /// an array of 2``, about a key the model never wrote, on an operation whose `height` a
    /// RectangleShape2D does not read at all.
    #[test]
    fn a_rename_never_lands_a_value_the_parameter_could_not_hold() {
        let mut held = json!({
            "path": "assets/player_shape.tres",
            "shapeType": "RectangleShape2D",
            "size_list": [16, 16],
            "height_list": [16, 16]
        });
        repair("godot_resource", "create_shape", &mut held);
        assert_eq!(held["size"], json!([16, 16]), "{held}");
        assert!(held.get("height").is_none(), "{held}");
        let refused = check("godot_resource", "create_shape", &held).expect_err("still refused");
        assert!(
            refused.message.contains("`height_list`"),
            "the refusal names the key the caller wrote: {}",
            refused.message
        );
    }

    /// A name and its value written as one key, with the separator lost between them.
    ///
    /// One live turn sent `create_shape` six times running and was refused six times. Five distinct
    /// shapes, every one of them `"<name> <value>": null` — the pair written, the colon and the
    /// quotes not. Neither existing repair reaches it, so the parameter was simply absent and the
    /// key beside it named nothing.
    #[test]
    fn a_name_and_its_value_written_as_one_key_are_read_as_a_pair() {
        let mut held = json!({
            "path": "shapes/player_shape.tres",
            "shapeType": "RectangleShape2D",
            "size [16, 16]": Value::Null
        });
        repair("godot_resource", "create_shape", &mut held);
        assert_eq!(held["size"], json!([16, 16]), "{held}");
        check_ok("godot_resource", "create_shape", held);

        let mut worded = json!({
            "path shapes/floor_shape.tres": Value::Null,
            "shapeType RectangleShape2D": Value::Null,
            "size [640, 16]": Value::Null
        });
        repair("godot_resource", "create_shape", &mut worded);
        assert_eq!(worded["path"], json!("shapes/floor_shape.tres"), "{worded}");
        assert_eq!(worded["shapeType"], json!("RectangleShape2D"), "{worded}");
        assert_eq!(worded["size"], json!([640, 16]), "{worded}");
        check_ok("godot_resource", "create_shape", worded);

        let mut both = json!({
            "index 0": 0,
            "name Coin1": Value::Null,
            "parent": "/Main",
            "path": "res://scenes/coin.tscn"
        });
        repair("godot_node", "instantiate", &mut both);
        assert_eq!(both["index"], json!(0), "{both}");
        assert_eq!(both["name"], json!("Coin1"), "{both}");
        check_ok("godot_node", "instantiate", both);

        let mut colon = json!({
            "name: Coin1": "Coin1",
            "parent": "/Main",
            "path": "res://scenes/coin.tscn"
        });
        repair("godot_node", "instantiate", &mut colon);
        assert_eq!(colon["name"], json!("Coin1"), "{colon}");
        check_ok("godot_node", "instantiate", colon);

        let mut twice = json!({
            "node": "/Main/Player",
            "node /Main/Player": Value::Null,
            "group": "player"
        });
        repair("godot_node", "add_to_group", &mut twice);
        assert!(twice.get("node /Main/Player").is_none(), "{twice}");
        check_ok("godot_node", "add_to_group", twice);
    }

    /// And what is not a value stays for `check` to name.
    #[test]
    fn a_key_that_swallowed_two_calls_is_not_read_as_a_pair() {
        let mut ran_together = json!({
            "path": "a.tres",
            "shapeType": "RectangleShape2D",
            "size [32, 32]}]edits": Value::Null
        });
        repair("godot_resource", "create_shape", &mut ran_together);
        assert!(ran_together.get("size").is_none(), "{ran_together}");

        let mut both = json!({"path shapes/a.tres, shapes/b.tres": Value::Null});
        repair("godot_resource", "rescan", &mut both);
        assert!(both.get("path").is_none(), "{both}");

        let mut wrong =
            json!({"path": "a.tres", "shapeType": "RectangleShape2D", "size 16": Value::Null});
        repair("godot_resource", "create_shape", &mut wrong);
        assert!(wrong.get("size").is_none(), "{wrong}");
    }

    /// Wreckage over a call that is complete without it does not stop the call.
    ///
    /// The entry a live turn sent eight times running while building a Breakout board. `parent`
    /// and `path` are both right, `name` is optional, and the only thing wrong is a piece of the
    /// model's own wreckage beside them. Three plain refusals, then five from the repeat guard,
    /// and the board never got its bricks.
    #[test]
    fn wreckage_over_a_call_that_is_complete_without_it_is_taken_away() {
        let mut entry = serde_json::Map::new();
        entry.insert("parent".to_owned(), json!("/Main"));
        entry.insert("path".to_owned(), json!("res://scenes/brick.tscn"));
        entry.insert(
            "name': null}]_1_1_PLACEHOLDER_1_1'}, {".to_owned(),
            Value::Null,
        );
        let mut held = Value::Object(entry);
        repair("godot_node", "instantiate", &mut held);
        assert_eq!(held["parent"], json!("/Main"), "{held}");
        assert_eq!(held["path"], json!("res://scenes/brick.tscn"), "{held}");
        assert_eq!(
            held.as_object().expect("an object").len(),
            2,
            "the wreckage is gone and nothing else is: {held}"
        );
        check_ok("godot_node", "instantiate", held);

        let mut with_op = json!({
            "op": "instantiate",
            "parent": "/Main",
            "path": "res://scenes/brick.tscn",
            "name': null}]": Value::Null
        });
        repair("godot_node", "instantiate", &mut with_op);
        assert!(with_op.get("name': null}]").is_none(), "{with_op}");

        let mut edited = json!({
            "files": [{"path": "a.gd", "edits": [{"oldText": "x", "newText": "y"}]}],
            "op_save": Value::Null
        });
        repair("godot_script", "edit", &mut edited);
        check_ok("godot_script", "edit", edited);
    }

    /// And a call that is not complete, or wreckage that holds something, keeps its refusal.
    #[test]
    fn a_call_short_of_a_required_parameter_still_names_what_is_wrong() {
        let mut short = json!({"parent": "/Main", "namexx": Value::Null});
        repair("godot_node", "instantiate", &mut short);
        assert!(short.get("namexx").is_some(), "{short}");
        check("godot_node", "instantiate", &short).expect_err("still refused");

        let mut noted = json!({
            "files": [{"path": "a.gd", "edits": [{"oldText": "x", "newText": "y"}]}],
            "edits_note": "ball keeps wall bounces"
        });
        repair("godot_script", "edit", &mut noted);
        assert!(noted.get("edits_note").is_some(), "{noted}");
        check("godot_script", "edit", &noted).expect_err("still refused");
    }

    /// A key that swallowed an operation boundary is not a misspelling.
    ///
    /// The commonest tear in the recordings, and the one that was always answered with the near
    /// miss. Every string here is off a live turn: `coin01`, `brick06`, `r2-medium-2` and `grid09`
    /// between them, five of the night's nine runs.
    #[test]
    fn a_key_that_swallowed_the_next_operation_says_the_list_came_apart() {
        for key in [
            "name\": \"Coin1\"}, {",
            "name': null}]_1_1_PLACEHOLDER_1_1'}, {",
            "name\": \"Coin1\"}, {\"op\": \"instantiate\", \"parent\": \"/Main\", \"p",
            "name\": \"Coin1\"}]}, {\": {}}]  ",
        ] {
            let mut entry = serde_json::Map::new();
            entry.insert("parent".to_owned(), json!("/Main"));
            entry.insert("path".to_owned(), json!("res://scenes/coin.tscn"));
            entry.insert(key.to_owned(), json!("something"));
            let refused =
                check("godot_node", "instantiate", &Value::Object(entry)).expect_err("refused");
            assert_eq!(refused.code, "torn_param", "{key}: {}", refused.message);
            assert!(
                refused.message.contains("came apart between two entries"),
                "{key}: {}",
                refused.message
            );
            assert!(
                !refused.message.contains("Did you mean"),
                "the near miss is the one thing that is not wrong here: {}",
                refused.message
            );
            assert!(
                refused.message.contains("send fewer entries"),
                "the answer being cut off is what wrote most of these: {}",
                refused.message
            );
        }

        let ordinary = check(
            "godot_node",
            "instantiate",
            &json!({"parent": "/Main", "path": "a.tscn", "namex": "Coin1"}),
        )
        .expect_err("refused");
        assert_eq!(ordinary.code, "unknown_param", "{}", ordinary.message);
        assert!(
            ordinary.message.contains("Did you mean `name`?"),
            "{}",
            ordinary.message
        );
    }

    /// A flat entry is folded into its list past the parameters that are not entry fields.
    ///
    /// `spread` took every key but `op` and `timeoutMs`, so it swept in the operation's own
    /// top-level parameters as well as the stray entry — `node` on `set_cells`, and the hidden
    /// `expectedRevision` the caller lifts onto any mutating call. `exactly_fits` then said no, the
    /// single-key branch found three keys rather than one, and the fold declined; the call was
    /// refused for a missing `cells` with every value it needed sitting in front of it.
    ///
    /// The tests missed it because `godot_script edit` takes `files` and nothing else, and it is the
    /// one shape where a parameter that is not an entry field cannot be there to be swept.
    #[test]
    fn a_flat_entry_is_folded_past_the_parameters_that_are_not_entry_fields() {
        let mut beside_a_sibling = json!({"node": "/Map", "x": 1, "y": 2});
        repair("godot_node", "set_cells", &mut beside_a_sibling);
        assert_eq!(
            beside_a_sibling["cells"],
            json!([{"x": 1, "y": 2}]),
            "a required sibling is not a field of the entry: {beside_a_sibling}"
        );
        assert_eq!(
            beside_a_sibling["node"],
            json!("/Map"),
            "and it stays where the operation declared it: {beside_a_sibling}"
        );
        check_ok("godot_node", "set_cells", beside_a_sibling);

        let mut with_revision = json!({"node": "/Map", "x": 1, "y": 2, "expectedRevision": 3});
        repair("godot_node", "set_cells", &mut with_revision);
        assert_eq!(
            with_revision["cells"],
            json!([{"x": 1, "y": 2}]),
            "a hidden parameter is not a field of the entry either: {with_revision}"
        );
        assert_eq!(
            with_revision["expectedRevision"],
            json!(3),
            "{with_revision}"
        );
        check_ok("godot_node", "set_cells", with_revision);
    }

    /// Every repair in the shared corpus is made by the engine the corpus says makes it.
    ///
    /// The twin of `every repair in the shared corpus is made by the engine that owns it` in
    /// `scripts/tool-call-repair.test.mjs`, over the same rows of
    /// `fixtures/tool-call-repairs.json`. Two engines repair a torn tool call, and the line
    /// between them was written down twice in prose and checked nowhere: the worker repairs what
    /// the agent loop's schema refuses before this table is reached, and this table repairs
    /// everything a value or a key means. That is exactly how a fix for the double-wrapped tag
    /// came to exist only in JavaScript while both suites stayed green.
    ///
    /// Both halves of every row are asserted, here and there:
    ///
    /// - `router` and `both`: this engine turns `wrote` into `becomes`.
    /// - `worker`: this engine leaves `wrote` alone, because the entry never arrives — the
    ///   generated schema for a nested entry and for a tagged value is closed, so the agent loop
    ///   refuses it first, and the worker is the only layer that can answer it.
    ///
    /// So a repair that migrates from one engine to the other fails on one side or the other,
    /// rather than silently existing twice or nowhere.
    #[test]
    fn every_repair_in_the_shared_corpus_is_made_by_the_engine_that_owns_it() {
        let corpus: Value = serde_json::from_slice(
            &std::fs::read(
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../fixtures/tool-call-repairs.json"),
            )
            .expect("read the shared repair corpus"),
        )
        .expect("parse the shared repair corpus");
        let rows = corpus["repairs"].as_array().expect("corpus repairs");
        assert!(rows.len() > 10, "the corpus lost its repairs");

        for row in rows {
            let tool = row["tool"].as_str().expect("a tool");
            let op = row["op"].as_str().expect("an op");
            let why = row["why"].as_str().expect("a reason");
            let owner = row["repairedBy"].as_str().expect("an engine");
            assert!(
                matches!(owner, "both" | "router" | "worker"),
                "{why}: {owner} is not an engine"
            );
            assert!(
                operation_of(tool, op).is_some(),
                "{tool} has no {op} operation"
            );
            let mut ran = row["wrote"].clone();
            repair(tool, op, &mut ran);
            let wanted = if owner == "worker" {
                &row["wrote"]
            } else {
                &row["becomes"]
            };
            assert_eq!(&ran, wanted, "{tool} {op}: {why}");
        }
    }
}
