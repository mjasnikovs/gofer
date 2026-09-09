//! What a model wrote, held to the shape the protocol takes, and refused by name where it is not.
//!
//! This was the second half of `tool_params`, under the generated table. It shares nothing with
//! that table but the row it is handed: the table says what an operation *is*, and this says what
//! a call to one has to survive. [`Operation::check`] is still the way in, so no caller moved.
//!
//! It had a repairing half beside it, which rewrote a call before this refused one. That half
//! changed 0 of 3,199 recorded entries once the generated schema closed each operation's entry and
//! the tagged value's payload, so it is gone: a shape the schema refuses never reaches this
//! process, and the worker's `normalizeToolCalls` answers those. What is left here is arithmetic
//! on JSON that no schema can carry — the wording of a refusal, which names the operation, the
//! parameter, its position and what arrived, so a model can act on it.
use crate::ai_tools::ToolFailure;
#[cfg(test)]
use crate::tool_params::operation_of;
use crate::tool_params::{GODOT_TAG_PAYLOAD, Kind, Param, Payload, signature};
use serde_json::{Value, json};

/// `timeoutMs` is lifted out of the parameters by the router for every command, so it is accepted
/// everywhere rather than repeated in forty tables.
///
/// `op` is not here. It names the entry rather than parameterising it, and the router takes it out
/// of the entry before anything — this check, the policy, the approval, the addon — sees one.
const UNIVERSAL: &[&str] = &["timeoutMs"];

/// How a call is spelled to the model: the domain without its `godot_` prefix, a dot, the op.
///
/// The catalogue names the domain `godot_node` and the router still answers to that, but the one
/// tool the model is given takes `node.create` — so a refusal naming the domain would be telling
/// it to write a call the schema refuses.
pub(crate) fn dotted(tool: &str, op: &str) -> String {
    format!("{}.{op}", tool.strip_prefix("godot_").unwrap_or(tool))
}

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
/// position. `script.edit \`files[0].edits[1]\` requires \`oldText\`` names all three.
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
/// The tool is read off the call's own name, which `check_set` is given as "runtime.input".
fn an_operation_of_this_tool(call: &str, key: &str) -> bool {
    let Some((short, op)) = call.split_once('.') else {
        return false;
    };
    crate::ai_tools::CATALOG
        .iter()
        .filter(|domain| domain.name.strip_prefix("godot_") == Some(short))
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
/// entry that makes it work: those were a node's parameters, and the sentence asked for something
/// that does not exist.
///
/// So the keys are matched against every operation in the catalogue, both ways — every required
/// parameter present, nothing held that the operation does not declare — and named only when
/// exactly one fits. `{"path": …}` alone fits eleven operations and says nothing; `{parent, path}`
/// fits one.
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
                let named = dotted(domain.name, operation.op);
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
/// `script.edit \`files[0]\` requires \`path\`` is the second commonest refusal in the recorded
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

/// Whether every element of a packed array's payload is an element of the type the tag names.
fn packed_of(inner: &Value, fits: impl Fn(&Value) -> bool) -> bool {
    inner.as_array().is_some_and(|items| items.iter().all(fits))
}

/// How many numbers a payload is written as, where it is written as numbers at all.
///
/// A colour is four of them and also a name, so a refusal that hands the numbers back has to know
/// both — the shape is the same however the value may also be spelled.
fn how_many_numbers(payload: &Payload) -> Option<usize> {
    match payload {
        Payload::Numbers(count) => Some(*count),
        Payload::Colour => Some(4),
        _ => None,
    }
}

fn check_tagged(call: &str, here: &str, param: &Param, value: &Value) -> Result<(), ToolFailure> {
    let example = "{\"type\": \"Vector2\", \"value\": [12, 34]}";
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
    let Some((_, payload)) = GODOT_TAG_PAYLOAD.iter().find(|(name, _)| *name == tag) else {
        let names: Vec<&str> = GODOT_TAG_PAYLOAD.iter().map(|(name, _)| *name).collect();
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
        Payload::Null => (!inner.is_null()).then(|| "null".to_owned()),
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
        Payload::PackedIntegers => (!packed_of(inner, |item| {
            item.as_f64().is_some_and(|number| number.fract() == 0.0)
        }))
        .then(|| "an array of whole numbers".to_owned()),
        Payload::PackedNumbers => {
            (!packed_of(inner, Value::is_number)).then(|| "an array of numbers".to_owned())
        }
        Payload::PackedStrings => {
            (!packed_of(inner, Value::is_string)).then(|| "an array of strings".to_owned())
        }
        Payload::PackedComponents(count) => (!packed_of(inner, |item| {
            item.as_array().is_some_and(|components| {
                components.len() == *count && components.iter().all(Value::is_number)
            })
        }))
        .then(|| format!("an array of arrays of {count} numbers")),
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
            format!(" Send {{\"type\": \"Resource\", \"value\": {{\"path\": \"{path}\"}}}}.")
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

    /// One property write, in the only shape there is for one: an entry of the batch.
    fn one_property(entry: Value) -> Value {
        json!({"properties": [entry]})
    }

    fn message(domain: &str, op: &str, params: Value) -> String {
        check(domain, op, &params)
            .expect_err("the call is refused")
            .message
    }

    /// A command line is a list of strings, and saying only "list" let anything through.
    ///
    /// `str()` in the addon turns a number or an object into a token and hands it to the game, so a
    /// call that was never a command line launched one anyway. The kind is what refuses it, by the
    /// index that is wrong, before the editor is asked.
    #[test]
    fn a_play_argument_that_is_not_text_is_refused_by_its_index() {
        check_ok(
            "godot_runtime",
            "run",
            json!({"playArgs": ["--", "--rate=30"]}),
        );

        let numbers = message("godot_runtime", "run", json!({"playArgs": [30]}));
        assert!(numbers.contains("playArgs[0]"), "{numbers}");
        let objects = message(
            "godot_runtime",
            "run",
            json!({"playArgs": [{"arg": "--rate=30"}]}),
        );
        assert!(objects.contains("playArgs[0]"), "{objects}");
    }

    /// A whole operation written to the wrong tool, and the sentence that says which one it is.
    ///
    /// `loc-12-mainscene` wrote eight operations to `godot_scene`, seven of them node creations,
    /// was refused for one key, and **resent all eight byte for byte**. The refusal had asked it to
    /// correct one key and send the list again, and there is no correction to a node's parameters
    /// that makes `godot_scene create` take them.
    #[test]
    fn an_operation_written_to_the_wrong_tool_is_told_which_tool_it_is() {
        let misplaced = json!({"parent": "/Platformer", "path": "res://scenes/brick.tscn"});

        let refused = message("godot_scene", "create", misplaced);
        assert!(
            refused.contains("node.instantiate's parameter list exactly"),
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
    }

    /// A value of the smallest shape a parameter of this kind will take.
    ///
    /// Only what the kind needs to be legal — a path is `"a"` and a number is `1`, because what is
    /// under test is whether the call is read as this operation's, not whether it is sensible.
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

    /// A call the router already accepts is never read as another operation's.
    ///
    /// [`the_operation_these_keys_belong_to`] is a hint printed when a refusal would otherwise be
    /// about a word rather than about the whole call being in the wrong place. Asked of a call that
    /// is already right, the honest answer is always "no", and it once got that wrong: it read
    /// every good `add_to_group` as a `remove_from_group`, because the two take the same two
    /// parameters. So it is asked of every operation in the catalogue.
    #[test]
    fn a_call_the_router_accepts_is_never_read_as_another_operation() {
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
                        &dotted(domain.name, operation.op),
                        params,
                        least.as_object().expect("an object")
                    ),
                    None,
                    "{} {} was read as another operation's call",
                    domain.name,
                    operation.op
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

    /// No parameter is named with a number on the end.
    ///
    /// A key like `nameCoin1` is wreckage rather than a misspelling, and the refusal above says so
    /// by counting the tear. A real parameter ending in a digit would make that reading ambiguous.
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
    /// before the check runs. Counted as a written key it made `{parent, name, type}` fit nothing,
    /// and `loc-71-autoload` was answered about `parent` — three wrong words instead of one
    /// misplaced operation. Adding that one key reproduces the live message exactly, which is how
    /// the difference between the live run and a probe of the same object was finally read.
    #[test]
    fn a_parameter_the_router_supplies_does_not_hide_a_misplaced_operation() {
        for call in [
            json!({"name": "ScoreLabel", "parent": "/Main", "path": "res://score.tscn"}),
            json!({
                "name": "ScoreLabel",
                "parent": "/Main",
                "path": "res://score.tscn",
                "expectedRevision": 3
            }),
        ] {
            let said = message("godot_scene", "create", call.clone());
            assert!(
                said.contains("node.instantiate's parameter list exactly"),
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
                let named = dotted(domain.name, operation.op);
                let mut fitting: Vec<(&str, &str)> = CATALOG
                    .iter()
                    .flat_map(|other| other.operations.iter().map(move |op| (other.name, op.op)))
                    .filter(|(tool, op)| {
                        let sent = dotted(tool, op);
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
                    the_operation_these_keys_belong_to(&dotted(tool, op), spec, &carried)
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

    /// A colour may be written the way Godot writes one, and the way it always could.
    ///
    /// `resource.create_texture` takes "skyblue" and "#8b5a2b" because `Color.from_string` does,
    /// and a `color` value refusing them made the same tool spell a colour two ways. One live turn
    /// wrote "red" for a `modulate` and was told a colour is four numbers.
    #[test]
    fn a_colour_may_be_named_as_well_as_counted() {
        for value in [
            json!({"type": "Color", "value": "red"}),
            json!({"type": "Color", "value": "#8b5a2b"}),
            json!({"type": "Color", "value": [1, 0.5, 0.25, 1]}),
        ] {
            check_ok(
                "godot_node",
                "set_properties",
                one_property(
                    json!({"node": "/Main/Player", "property": "modulate", "value": value}),
                ),
            );
        }

        let neither = message(
            "godot_node",
            "set_properties",
            one_property(json!({
                "node": "/Main/Player",
                "property": "modulate",
                "value": {"type": "Color", "value": 7}
            })),
        );
        assert!(neither.contains("name like skyblue"), "{neither}");
    }

    /// A resource wrapper that is right with a path that is empty says so, rather than contradicting
    /// itself.
    ///
    /// Observed live: `{"type": "Resource", "value": {"path": ""}}` for a material the turn had not
    /// made yet, answered `a resource value takes an object carrying a path, and this one was an
    /// object holding path` — a sentence that says the shape is wrong when the shape is right, and
    /// never names the empty string that is.
    #[test]
    fn an_empty_resource_path_is_named_as_one() {
        let empty = message(
            "godot_node",
            "set_properties",
            one_property(json!({
                "node": "/Game/Ground",
                "property": "material",
                "value": {"type": "Resource", "value": {"path": ""}}
            })),
        );
        assert!(
            empty.contains("this one's is empty") && !empty.contains("an object holding path"),
            "{empty}"
        );

        let shapeless = message(
            "godot_node",
            "set_properties",
            one_property(json!({
                "node": "/Game/Ground",
                "property": "material",
                "value": {"type": "Resource", "value": {"res": "a.tres"}}
            })),
        );
        assert!(
            shapeless.contains("an object carrying a path"),
            "{shapeless}"
        );
    }

    /// A torn key that took an optional parameter is named without its wreckage read back.
    #[test]
    fn a_tear_that_took_an_optional_parameter_names_the_parameter_not_the_tear() {
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

    /// A blank key is shown as one, rather than as nothing at all.
    ///
    /// An `AnimationPlayer`'s default library is keyed with the empty string, so a live turn sent
    /// `{"type": "Dictionary", "value": {"": …}}` and read back ``a dictionary value takes an array
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

    /// The failure this whole module exists for. The old answer was
    /// `A resource value requires an object carrying a path`, which a model read eight times
    /// without changing anything, because it never showed the wrapper or repeated the path.
    #[test]
    fn a_resource_written_as_a_string_is_answered_with_the_corrected_call() {
        let refused = message(
            "godot_node",
            "set_properties",
            json!({
                "properties": [{
                    "node": "/Player",
                    "property": "script",
                    "value": {"type": "Resource", "value": "res://scripts/player.gd"}
                }],
                "expectedRevision": 1
            }),
        );
        assert!(
            refused.contains(
                "Send {\"type\": \"Resource\", \"value\": {\"path\": \"res://scripts/player.gd\"}}."
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
                {"kind": "mouse_button", "button": "MOUSE_BUTTON_LEFT"},
                {"kind": "joypad_button", "joypadButton": "JOY_BUTTON_DPAD_LEFT"}
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
                     "value": {"type": "Vector2", "value": [1, 2]}}
                ],
                "expectedRevision": 3
            }),
        );
        let refused = message(
            "godot_node",
            "set_properties",
            json!({
                "properties": [{"node": "/Player", "property": "script",
                                "value": {"type": "Resource", "value": "res://a.gd"}}]
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
            "set_properties",
            json!({
                "properties": [{
                    "node": "/Player",
                    "property": "script",
                    "value": {"type": "Resource", "value": {"path": "res://scripts/player.gd"}}
                }],
                "expectedRevision": 1
            }),
        );
        check_ok(
            "godot_node",
            "set_properties",
            json!({
                "properties": [{
                    "node": "/Player/Sprite2D",
                    "property": "region_rect",
                    "value": {"type": "Rect2", "value": [112, 0, 16, 16]}
                }],
                "expectedRevision": 2
            }),
        );
    }

    #[test]
    fn a_missing_parameter_names_itself_and_the_whole_shape() {
        let refused = message(
            "godot_node",
            "set_properties",
            json!({
                "properties": [{"node": "/Player", "value": {"type": "int", "value": 1}}],
                "expectedRevision": 1
            }),
        );
        assert!(refused.contains("requires `property`"), "{refused}");
        assert!(
            refused.contains("{node: text, property: text, value: tagged}"),
            "{refused}"
        );
        assert!(
            refused.contains("This one carries node, value."),
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
            "create_nodes",
            json!({
                "nodes": [{
                    "parent": "/Level",
                    "type": "Sprite2D",
                    "name": "Coin",
                    "nodeIndex": 2
                }],
                "expectedRevision": 1
            }),
        );
        assert!(refused.contains("has no `nodeIndex` key"), "{refused}");
    }

    #[test]
    fn a_wrong_arity_names_the_count_it_wanted() {
        let refused = message(
            "godot_node",
            "set_properties",
            json!({
                "properties": [{
                    "node": "/Player",
                    "property": "position",
                    "value": {"type": "Vector2", "value": [12]}
                }],
                "expectedRevision": 1
            }),
        );
        assert!(refused.contains("an array of 2 numbers"), "{refused}");
    }

    /// A live run wrote `{"x": 32, "y": 32}` for a vector2 thirteen times and was refused thirteen
    /// times. The sentence said what was wanted and never what to send, so the numbers it already
    /// had were never handed back to it in the right shape.
    ///
    /// An agent call no longer reaches this: the generated grammar cannot write a vector as an
    /// object. The sentence is still what a caller with no schema in front of it — the desktop
    /// client, an acceptance suite — is answered with.
    #[test]
    fn a_vector_written_as_an_object_is_refused_with_the_value_it_should_have_sent() {
        let refused = message(
            "godot_node",
            "set_properties",
            one_property(json!({
                "node": "/Player",
                "property": "position",
                "value": {"type": "Vector2", "value": {"x": 32, "y": 48}}
            })),
        );
        assert!(refused.contains("an object holding x, y"), "{refused}");
        assert!(
            refused.contains(r#"Send {"type": "Vector2", "value": [32, 48]}"#),
            "{refused}"
        );

        let colour = message(
            "godot_node",
            "set_properties",
            one_property(json!({
                "node": "/Player",
                "property": "modulate",
                "value": {"type": "Color", "value": {"r": 1, "g": 0.5, "b": 0.25, "a": 1}}
            })),
        );
        assert!(
            colour.contains(r#"Send {"type": "Color", "value": [1, 0.5, 0.25, 1]}"#),
            "{colour}"
        );
    }

    /// Only where the order is not a guess. Four numbers under four names that are not a colour or
    /// a vector could be a rect2 in either order, so nothing is offered rather than the wrong thing.
    #[test]
    fn numbers_under_names_nobody_can_order_are_left_without_a_correction() {
        let refused = message(
            "godot_node",
            "set_properties",
            one_property(json!({
                "node": "/Player",
                "property": "rect",
                "value": {"type": "Rect2", "value": {"top": 0, "left": 1, "width": 2, "height": 3}}
            })),
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
            "create_nodes",
            json!({
                "nodes": [{"parent": "/Level", "type": "Sprite2D", "name": "Coin"}],
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
        assert!(refused.contains("Vector2"), "{refused}");
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
        check_ok(
            "godot_script",
            "open",
            json!({"paths": ["scripts/mario.gd"]}),
        );
        check_ok("godot_node", "set_properties", json!("not an object"));
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

    /// A tile size is two whole numbers and nothing else.
    ///
    /// It used to be one number *or* two, and a parameter of two kinds was the shape a constrained
    /// sampler got wrong oftenest — 73% invalid on `create_shape.size` under the merged bag. There
    /// is no second spelling left to be wrong about, and the old one is refused by name.
    #[test]
    fn a_tile_size_is_two_numbers_and_the_old_spelling_is_refused_by_name() {
        check_ok(
            "godot_resource",
            "create_tileset",
            json!({"path": "a.tres", "texture": "t.png", "tileWidth": 16, "tileHeight": 24}),
        );
        check_ok(
            "godot_resource",
            "create_tileset",
            json!({"path": "a.tres", "texture": "t.png"}),
        );
        let refused = message(
            "godot_resource",
            "create_tileset",
            json!({"path": "a.tres", "texture": "t.png", "tileSize": [16, 16]}),
        );
        assert!(refused.contains("has no `tileSize` parameter"), "{refused}");
        let wrong = message(
            "godot_resource",
            "create_tileset",
            json!({"path": "a.tres", "texture": "t.png", "tileWidth": "16"}),
        );
        assert!(wrong.contains("a whole number"), "{wrong}");
    }

    /// The signature is what the model reads, so it has to say which parameters are optional — and
    /// leave out the ones the router fills in, which a model that reads it will otherwise try to
    /// supply.
    #[test]
    fn the_signature_marks_the_optional_parameters() {
        let params =
            params_of("godot_node", "instantiate").expect("node.instantiate is in the table");
        assert_eq!(
            signature(params),
            "{parent: text, path: text, name?: text, index?: int}"
        );
        assert_eq!(signature(&[]), "");
    }

    /// The form the fixture says a recorded call has to become is the form `check` accepts.
    ///
    /// `fixtures/recorded-tool-calls.json` carries nine calls under `repairs` that a model really
    /// wrote and the router really refused, each beside the `repaired` form it had to become. The
    /// shape every one of them got wrong — a tagged value wrapped in a second copy of its own tag
    /// — is one the closed `taggedValue` schema now refuses outright, so no router rewrites it any
    /// more and what is left to hold here is the far end: the corrected call passes.
    ///
    /// That the raw form is refused is asserted where a JSON-schema validator lives, in
    /// `scripts/tool-call-repair.test.mjs`.
    #[test]
    fn the_repaired_form_of_every_recorded_call_passes_the_check() {
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
                if check(tool, op, &without_op(entry)).is_err() {
                    refused_as_written += 1;
                }
                check(tool, op, &without_op(want)).unwrap_or_else(|failure| {
                    panic!("{tool} {op} is refused as corrected: {}", failure.message)
                });
            }
            assert!(
                refused_as_written > 0,
                "{tool} records a correction of a call nothing was going to refuse"
            );
        }
    }

    /// One entry's parameters, which is what both corpus tests hold a row to.
    fn without_op(entry: &Value) -> Value {
        let mut params = entry.clone();
        if let Some(object) = params.as_object_mut() {
            object.remove("op");
        }
        params
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

    /// And a call that is not complete, or wreckage that holds something, keeps its refusal.
    #[test]
    fn a_call_short_of_a_required_parameter_still_names_what_is_wrong() {
        let short = json!({"parent": "/Main", "namexx": Value::Null});
        check("godot_node", "instantiate", &short).expect_err("still refused");

        let noted = json!({
            "files": [{"path": "a.gd", "edits": [{"oldText": "x", "newText": "y"}]}],
            "edits_note": "ball keeps wall bounces"
        });
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

    /// Every row of the shared corpus names an engine that still exists, and lands on a call
    /// this table accepts.
    ///
    /// The twin of `every repair in the shared corpus is made by the engine that owns it` in
    /// `scripts/tool-call-repair.test.mjs`, over the same rows of `fixtures/tool-call-repairs.json`.
    /// Two things repair a torn tool call now, and neither is here: the worker rewrites what the
    /// agent loop's schema refuses, and the schema itself refuses the rest before this process is
    /// reached. So what this side owns is the far end of every row — the corrected call is one
    /// `check` accepts — and `router` is no longer an engine a row may name.
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
                matches!(owner, "schema" | "worker"),
                "{why}: {owner} is not an engine"
            );
            assert!(
                operation_of(tool, op).is_some(),
                "{tool} has no {op} operation"
            );
            check(tool, op, &row["becomes"]).unwrap_or_else(|failure| {
                panic!(
                    "{tool} {op}: {why} — the corrected call is refused: {}",
                    failure.message
                )
            });
        }
    }
}
