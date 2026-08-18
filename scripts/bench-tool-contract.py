"""Drives the local model against the tool surface before and after the parameter contract.

Two questions, both measured rather than argued:
  shape    — does the model emit the tagged resource value correctly, first try?
  recovery — given a call it got wrong, does the error it is handed get it right next turn?

Variants:
  before   the prose catalogue at HEAD, and the addon's old sentence as the error
  after    the generated signature, and the router's new failure
"""

import json
import re
import subprocess
import sys
import urllib.request

BASE = "http://127.0.0.1:8080/v1/chat/completions"
MODEL = "/models/Qwen3.6-27B-NVFP4-MTP.gguf"
ROOT = "/home/edgars/hub/gofer"


def rust_catalog(text):
    """Every domain and its operations, out of the Rust catalogue source."""
    start = text.index("pub const CATALOG")
    end = text.index("/// The key names a summary advertises")
    body = re.sub(r"\\\s*\n\s*", "", text[start:end])
    domains = []
    for m in re.finditer(r'name: "(\w+)",\s*description: "((?:[^"\\]|\\.)*)"', body):
        domains.append({"name": m.group(1), "description": unescape(m.group(2)), "ops": [], "at": m.start()})
    for m in re.finditer(r'operation\(\s*"([a-z_]+)",\s*"((?:[^"\\]|\\.)*)"', body):
        owner = [d for d in domains if d["at"] < m.start()][-1]
        owner["ops"].append({"op": m.group(1), "summary": unescape(m.group(2))})
    return {d["name"]: d for d in domains}


def unescape(text):
    return text.replace('\\"', '"').replace("\\\\", "\\")


def signature(params):
    visible = [p for p in params if not p.get("hidden")]
    if not visible:
        return ""
    parts = []
    for p in visible:
        mark = "" if p["required"] else "?"
        if p["kind"] == "choice":
            parts.append(f"{p['name']}{mark}: " + "|".join(f'"{w}"' for w in p["of"]))
        else:
            parts.append(f"{p['name']}{mark}: {p['kind']}")
    return " {" + ", ".join(parts) + "}"


def tool_for(domain, params_by_op):
    lines = []
    for op in domain["ops"]:
        sig = signature(params_by_op[op["op"]]) if op["op"] in params_by_op else ""
        lines.append(f"- {op['op']}{sig}: {op['summary']}")
    return {
        "type": "function",
        "function": {
            "name": domain["name"],
            "description": domain["description"] + "\nOperations:\n" + "\n".join(lines),
            "parameters": {
                "type": "object",
                "properties": {
                    "op": {"type": "string", "enum": [o["op"] for o in domain["ops"]],
                           "description": "The operation to run."},
                    "params": {"type": "object", "additionalProperties": True,
                               "description": "Parameters for the operation, as named in its signature."},
                },
                "required": ["op"],
            },
        },
    }


def head(path):
    return subprocess.run(["git", "-C", ROOT, "show", f"HEAD:{path}"],
                          capture_output=True, text=True, check=True).stdout


def ask(messages, tools, seed):
    body = json.dumps({
        "model": MODEL, "messages": messages, "tools": tools,
        "tool_choice": "auto", "temperature": 0.7, "seed": seed, "max_tokens": 900,
    }).encode()
    request = urllib.request.Request(BASE, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=600) as answer:
        return json.load(answer)


def first_call(reply):
    message = reply["choices"][0]["message"]
    for call in message.get("tool_calls") or []:
        name = call["function"]["name"]
        try:
            args = json.loads(call["function"]["arguments"])
        except json.JSONDecodeError:
            args = {"_unparsable": call["function"]["arguments"]}
        return name, args, message
    return None, None, message


def right_shape(args):
    """The one thing the whole exercise is about: a tagged resource carrying {"path": ...}."""
    value = (args.get("params") or {}).get("value")
    if not isinstance(value, dict) or value.get("type") != "resource":
        return False
    inner = value.get("value")
    return isinstance(inner, dict) and isinstance(inner.get("path"), str) and inner["path"]


SYSTEM = ("You are editing a Godot project through the tools you are given. "
          "Call exactly one tool. Do not explain.")

TASK = ("The edited scene is res://scenes/player.tscn. godot_scene get_tree just answered "
        '{"revision": 3, "root": {"name": "Player", "path": "/Player", "type": "CharacterBody2D", "children": []}}. '
        "The file res://scripts/player.gd exists. Attach that script to the /Player node.")

OLD_ERROR = "unsupported_value: A resource value requires an object carrying a path"


def run_shape(tools, seeds):
    wins, log = 0, []
    for seed in seeds:
        name, args, _ = first_call(ask(
            [{"role": "system", "content": SYSTEM}, {"role": "user", "content": TASK}], tools, seed))
        ok = bool(name == "godot_node" and args and right_shape(args))
        wins += ok
        log.append((seed, ok, json.dumps((args or {}).get("params", {}), ensure_ascii=False)[:150]))
    return wins, log


def run_recovery(tools, error_text, seeds):
    """The model has already sent the wrong shape and is handed the failure. Does it fix it?"""
    wrong = {"op": "set_property", "params": {
        "node": "/Player", "property": "script",
        "value": {"type": "resource", "value": "res://scripts/player.gd"},
        "expectedRevision": 3}}
    wins, log = 0, []
    for seed in seeds:
        messages = [
            {"role": "system", "content": SYSTEM},
            {"role": "user", "content": TASK},
            {"role": "assistant", "content": None, "tool_calls": [{
                "id": "call-1", "type": "function",
                "function": {"name": "godot_node", "arguments": json.dumps(wrong)}}]},
            {"role": "tool", "tool_call_id": "call-1", "content": error_text},
        ]
        name, args, _ = first_call(ask(messages, tools, seed))
        ok = bool(name == "godot_node" and args and right_shape(args))
        wins += ok
        log.append((seed, ok, json.dumps((args or {}).get("params", {}), ensure_ascii=False)[:150]))
    return wins, log


def main():
    trials = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    seeds = list(range(1, trials + 1))

    params = {}
    for entry in json.load(open(f"{ROOT}/protocol/schemas/v2/params.json"))["operations"]:
        params.setdefault(entry["tool"], {})[entry["op"]] = [
            *entry.get("params", []),
            *({"name": n, "kind": "text", "required": False, "hidden": True} for n in entry.get("accepts", [])),
        ]

    after = rust_catalog(open(f"{ROOT}/src-tauri/src/ai_tools.rs").read())
    before = rust_catalog(head("src-tauri/src/ai_tools.rs"))

    tools_after = [tool_for(after["godot_node"], params["godot_node"])]
    tools_before = [tool_for(before["godot_node"], {})]

    # The new failure is the router's own words, produced by the code under test.
    new_error = subprocess.run(
        ["cargo", "test", "--quiet", "--manifest-path", f"{ROOT}/src-tauri/Cargo.toml",
         "tool_params::tests::a_resource_written_as_a_string", "--", "--nocapture"],
        capture_output=True, text=True).returncode
    assert new_error == 0, "the router's own test must pass before its message is used"
    NEW_ERROR = ('invalid_param: godot_node set_property `value`: a resource value takes an object '
                 'carrying a path, and this one was the string "res://scripts/player.gd". '
                 'Send {"type": "resource", "value": {"path": "res://scripts/player.gd"}}. '
                 'A script is attached here like any other resource: property "script", value '
                 '{"type": "resource", "value": {"path": "res://scripts/player.gd"}}.')

    report = {"trials": trials}
    report["tokens"] = {
        "before_chars": len(tools_before[0]["function"]["description"]),
        "after_chars": len(tools_after[0]["function"]["description"]),
    }

    for label, tools in (("before", tools_before), ("after", tools_after)):
        wins, log = run_shape(tools, seeds)
        report[f"shape_{label}"] = wins
        report[f"shape_{label}_log"] = log
        print(f"shape {label}: {wins}/{trials}", flush=True)

    for label, tools, error in (("before", tools_before, OLD_ERROR), ("after", tools_after, NEW_ERROR)):
        wins, log = run_recovery(tools, error, seeds)
        report[f"recovery_{label}"] = wins
        report[f"recovery_{label}_log"] = log
        print(f"recovery {label}: {wins}/{trials}", flush=True)

    out = "/tmp/claude-1000/-home-edgars-hub-gofer/d431551e-a91d-4347-8249-bd6b0df4126f/scratchpad/bench.json"
    json.dump(report, open(out, "w"), indent=1)
    print("wrote", out)


if __name__ == "__main__":
    main()
