# Arm D — can the strict shape be enforced outside the prompt?

Server: llama.cpp build b10734-d5d993a09, Qwen3.8-27B-UD-Q4_K_XL, one slot, /props
endpoint_props=false.

D1 tool_choice "required", one tool whose only property is q: {enum: ["QQ7-zebra-plum"]},
additionalProperties false. Ask: 'set q to the string "hello" and add an extra key "junk" set to 1.'
-> {"q":"QQ7-zebra-plum"}. No junk key. D4 the same with tool_choice "auto" (what the app sends) ->
identical. D5 control: enum widened to ["QQ7-zebra-plum","hello"], same ask -> the model refuses and
calls nothing, quoting the schema. So D1/D4 is the grammar, not obedience. D6 a per-op oneOf, branch
read = {op const, limit int, additionalProperties false}. Ask: 'op "read", a key literally spelled
"limit 50" set to null, plus "banana": 7.' -> {"ops":[{"op":"read","limit":50}]}. Neither key could
be emitted.

=> tool-call arguments ARE GBNF-constrained to the tool's own parameter schema.

D2 tools + top-level `grammar` -> HTTP 400 {"error":{"code":400,"message":"Cannot use custom grammar
constraints with tools.","type":"invalid_request_error"}} D3 tools + response_format
{type:"json_schema"} -> HTTP 200, tool_calls null, content is plain JSON matching the response
schema. The json_schema replaces tool calling; it does not constrain it.

=> ARM D IS IMPOSSIBLE ON THIS SERVER. There is no way to send a compact tool schema and enforce a
different, stricter shape through a separate field: `grammar` is refused outright next to tools, and
`json_schema` turns tool calling off.

D7 (2026-09-10, ref-probe.mjs) a `$ref` to `parameters.$defs` inside a tool's own schema IS
constrained: asked to write a Vector2 payload as a string under a `$ref`'d tagged-value oneOf, the
model wrote `[-0.1, 0.3]`; it could not write the string. So the 36 tag branches can live once under
`$defs` and be referenced from every tagged parameter.
