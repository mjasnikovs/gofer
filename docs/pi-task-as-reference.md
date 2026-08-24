# Using pi-task as a reference, not as a dependency

Date: 2026-08-10 Status: standing briefing

Read this before lifting any behaviour from `pi-task` into Gofer. It exists so the same architecture
facts are not re-derived, and the same gray areas are not re-discovered, every time a feature is
borrowed.

Source: `~/.pi/agent/extensions/pi-task` · https://github.com/mjasnikovs/pi-task · same author.

---

## 1. What the two things are

**pi-task is a `pi` CLI extension.** Its entry point is `export default (pi: ExtensionAPI)`. It is
loaded into a running `pi` session. It talks to that session through `pi.on` (34 calls), `pi.emit`
(23), `pi.sendUserMessage` (5), `pi.getAllTools` (4), `pi.registerCommand` (1).

**Gofer never runs the `pi` CLI.** It depends on `@earendil-works/pi-agent-core` and
`@earendil-works/pi-ai` as _libraries_. Rust spawns one Node worker (`scripts/ai-worker.mjs`), which
builds one in-process `Agent` in `scripts/ai-provider.mjs`.

**pi-task does every model step by spawning a `pi --print` child process.** `CHILD_BASE_ARGS` is
`--print --no-skills --no-extensions --no-prompt-templates --no-context-files --no-session`. Those
children get pi's built-in tools only, selected with `--tools`. About 26 `runChild` calls across 10
files.

**Gofer's tools live in Rust.** `src-tauri/src/ai_tools.rs` holds the catalog. The Node worker
forwards each call back over an NDJSON duplex channel (`GOFER_AI_TOOL:` prefix). A spawned `pi`
child process cannot reach any of them.

### Consequence

pi-task cannot be installed, imported, or wrapped. There is nothing to depend on. Every borrowing is
a **port of an idea**, written fresh against Gofer's own seams.

---

## 2. Size, measured 2026-08-10

|                                            | non-test lines |
| ------------------------------------------ | -------------- |
| pi-task, all of `src/`                     | 47,620         |
| pi-task, `src/task/`                       | 34,370         |
| pi-task, the actual pipeline core          | 7,853          |
| pi-task, `src/workers/`                    | 6,403          |
| pi-task, `src/remote/` (web server + push) | 4,162          |
| Gofer, Rust                                | 35,071         |
| Gofer, TS/TSX                              | 15,646         |
| Gofer, `scripts/*.mjs`                     | 3,086          |

pi-task is nearly the size of Gofer. Gofer's whole agent layer is 3,086 lines. **Nothing here is a
small lift.** Borrow one behaviour at a time.

---

## 3. Translation table

When a pi-task feature is wanted, this is where it has to land instead.

| pi-task does it                                           | Gofer must do it                                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Registers a slash command (`pi.registerCommand`)          | A UI control, or an agent tool in the Rust catalog                                            |
| Asks the user via a TUI picker or editor dialog           | A real panel. See the `gofer-ui` skill first                                                  |
| Spawns a `pi --print` child for isolated work             | A second in-process `Agent` — **this seam does not exist yet**                                |
| Registers a tool in TypeScript (`makeWorkerTool`)         | A `ToolDomain` in `src-tauri/src/ai_tools.rs`                                                 |
| Reads config from `~/.config/pi-task/config.json`         | `src-tauri/src/settings.rs` + the settings page                                               |
| Reads a key from an env var (`BRAVE_SEARCH_API_KEY`)      | The OS keyring (`keyring = "4"`). A bundled app has no shell env                              |
| Caches in its own SQLite at `XDG_CACHE_HOME`              | `src-tauri/src/storage/`, next to RAG                                                         |
| Persists state to `.pi-tasks/TASK_NNNN.md`                | Gofer's task store. Its worktrees already exist                                               |
| Snapshots work with its own auto-commit + git-state-guard | Gofer already owns worktrees and merge. Do not add a second git owner                         |
| Tests with `bun test`                                     | vitest (frontend), `node --test` (scripts), `cargo test` (Rust). **Tests do not port at all** |

### Where a new tool actually lives

Gofer is **mixed**, and the split is not arbitrary. `createAgentTools` in `scripts/ai-provider.mjs`
builds `read`, `write`, `edit` and `bash` **in Node**, from `pi-agent-core`, wrapped by
`confineTool`. Only the `godot_*` domains are forwarded to Rust through `host.call`.

The rule that explains it:

| Kind of tool                                                                           | Where            | Why                                                                                           |
| -------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------- |
| A library tool `pi-agent-core` already ships                                           | Node             | It exists; Gofer only confines it                                                             |
| A Gofer-authored operation (search, fetch, anything hitting the network or the editor) | Rust             | Keyring, approvals, `storage/` caching, and the catalogue all live there                      |
| Anything needing a **model** — a sub-agent, an extractor, a critic                     | **Node, always** | Rust cannot build an `Agent`. The provider, models and streaming are all in `ai-provider.mjs` |

`scripts/ai-host.mjs` says the router in `ai_tools.rs` is the only place an operation exists. That
sentence is about _Godot_ operations. It does not make Node off-limits for model work.

---

## 4. Gray areas — the checklist

Work through these before writing code. Most are Gofer facts pi-task never had to face.

### 4.1 Prompt injection has no shield here

pi-task fetches a page and hands it to a `--no-tools` child to extract from. The parent never sees
the raw text. That isolation is deliberate and it is documented in its README.

Gofer has **one** agent. It holds `godot_*`, `bash`, `write`, and `edit`, live, against a real
editor and a real worktree. Any external text that lands in that context is an injection path to a
shell.

Gofer has no child-agent seam. Any borrowed feature that ingests external content needs that seam
built first, or it needs a hard reason why raw text never reaches the main context.

### 4.2 Confinement is file-shaped, not network-shaped

`scripts/workspace-confinement.mjs` bounds file and bash tools to the task worktree. Its header
states that confinement is _the whole safety story_ for those tools.

It says nothing about the network. A tool that reaches outward escapes that story silently. That is
a new safety question, not a covered one.

### 4.3 Approvals do not cover egress

`src-tauri/src/approvals.rs` gates deletes, moves, plugin enables, and machine-wide editor settings.
Everything else runs unasked, because the worktree is recoverable.

Network egress is not recoverable and is not in the model. Decide explicitly: does a search ask
first, and what is allowed to leave the machine?

### 4.4 The catalog is closed on purpose

`ai_tools.rs` has a test named `the_catalog_is_the_ten_agreed_domains`. It asserts the exact list.
Adding an eleventh domain fails it deliberately. That failure is the design asking you to confirm
the addition, not a chore.

### 4.5 The command surface is generated and checked

`scripts/check-command-surface.mjs` parses five surfaces and fails when a name appears on one and
not another. `scripts/generate-command-surface.mjs` writes some of them. Run `npm run generate` and
`npm run check:command-surface`. See the `gofer-command-seams` note.

### 4.6 The system prompt is part of the tool

`src-tauri/src/agent_prompt.rs` adds the Godot half only when `godot_*` tools are in the catalog,
and `is_default` keeps projects following the shipped text. A new tool that needs guidance means new
prompt text, and that changes what counts as default for every project.

### 4.7 Tool probes kill the turn, by design

`scripts/ai-reachability.mjs` probes every tool before the model is told anything. One tool that
cannot answer aborts the whole turn, naming it.

Its header states there is **no allow-list of tools that may skip this**. That rule was written
after ten live sweeps ended with zero documentation searches and no error to show for it. A dead
tool looks exactly like a model that chose not to call it.

That strictness is safe today because **every tool in the catalogue is guaranteed reachable by
construction**. Nine `godot_*` domains are compiled into the binary and start with the session. The
tenth, `godot_docs_search`, depends on a model cache outside the binary — and
`InitializationSplash.tsx` downloads it before the app is usable at all. So a probe has never had to
answer "legitimately absent".

**A network tool would be the first one that can be.** It cannot be guaranteed at a splash screen.
So it is not just a new tool; it introduces a new _tool class_ the probe has no policy for. Deciding
that policy is part of the work, not a `try` around the probe. Whatever is chosen, a degraded tool
must still be reported somewhere the user can see it — that is the whole lesson the strict rule came
from.

### 4.8 Gofer is local-first

Gofer runs local models against a local editor. Adding an outward-facing tool changes what "local"
means for the product, and what leaves the user's machine. That is a product decision, not an
implementation detail.

### 4.9 Licensing

pi-task is **AGPL-3.0-only**. Gofer is currently unlicensed and private. Copying _code_ makes the
derived file AGPL. Copying _ideas_ does not. Same author holds the copyright and the CLA allows
dual-licensing, so this is resolvable — but a blind paste creates a licensing fact nobody chose.

### 4.10 Runtime and lint differ

pi-task builds and tests with Bun and its own eslint/prettier config. Gofer pins Node `>=22.19.0`
and has its own. A lifted file will not pass `npm run check` unchanged.

### 4.11 The word "task" already means something here

Gofer's task is a git worktree plus its own chat conversation (`src/services/task-actions.ts`,
`TaskSummary`, `activate_chat_task`). pi-task's task is a spec file. If a pipeline is ever borrowed,
it needs a different word.

### 4.12 pi-task's own refutations are not Gofer's

`VALIDATION-DEBT.md` in pi-task records leads that were measured and ruled out. Read it before
proposing something it already killed. But its numbers came from pi-task's corpus. A refutation
there is a warning here, not a verdict.

---

## 5. What is worth borrowing

Ideas, in rough order of value to Gofer:

- **Loop detector** and **failure classifier** (`src/task/loop-detector.ts`,
  `failure-classifier.ts`). Gofer only retries transient errors today. It has nothing that sees a
  model repeating itself.
- **Stream watchdog** (`shared/stream-watchdog.ts`). A hung stream throws nothing, so Gofer's retry
  path cannot see it.
- **Command timeout.** A ceiling on one tool execution. Gofer's `bash` has none.
- **Thinking compression** (`src/thinking/`, 221 lines). Gofer compacts; it does not compress
  self-talk.
- **The phase pipeline** (refine → research → grill → compose → critique). Pure logic. The most
  valuable idea and by far the biggest port.
- **Crash-safe markdown state.** Readable, diffable, resumable.

## 6. What should never come over

- `src/remote/` — 4,162 lines of web server, WebSocket UI, QR codes, Web Push. **Gofer is the UI.**
- The npm-docs and web-fetch workers. Gofer already has RAG and `godot_docs_search`.
- Anything importing `@earendil-works/pi-tui`.
- `git-state-guard` and per-task auto-commit. Gofer owns its worktrees.

---

## 7. The rule

**Do not copy. Do not paste. Read it, understand why it exists, then write Gofer's version.**

Every pi-task guard was earned from a real failure in a CLI extension driving local models over
child processes. Some of those failures cannot happen in Gofer. Some Gofer failures cannot happen
there. A pasted guard defends against the wrong thing and costs the same to maintain.

Before borrowing anything, answer three questions in writing:

1. Which Gofer failure does this prevent? Name one that has actually happened.
2. Which seam does it attach to — Rust catalog, Node worker, or UI?
3. What does it need that Gofer does not have yet?

If question 1 has no answer, do not port it.

---

## 8. The agreed first step — a sub-agent seam

Decided 2026-08-10. Build Gofer's equivalent of `pi-worker` **before** anything else.

pi-worker spawns an isolated child with read + bash and returns only the distilled answer. The
parent never sees the raw file or the raw page.

In Gofer that is a **second in-process `Agent`** in `scripts/ai-provider.mjs`. Not a process. Not a
Rust call. Rust cannot build an `Agent`; the provider, the models and the streaming are all already
there.

Why this is first, and not just convenient:

- It is the missing seam. Everything else in this file that says _"Gofer has no child-agent seam"_
  stops being blocked the moment it exists.
- **It is the injection shield** (§4.1). Once a child can hold external text and return a summary,
  web search and page fetch become safe to add. Before it, they are not.
- It saves context on its own merits, which is the reason pi-worker exists at all.
- It is small. One `Agent`, a narrower tool list, a bounded return.

What it needs decided:

- Which tools the child gets. Almost certainly `read` and `bash`, never `godot_*`, never `write`,
  never `edit`.
- Whether it streams to the UI or only reports when done.
- How its token use is counted and shown.
- What a child failure looks like to the parent. pi-task formats this in exactly one place
  (`formatChildFailure`) so the rule cannot drift. Copy that discipline, not that function.
- Whether the child is cancellable by the same abort signal as the parent turn.

Read `src/workers/pi-worker-core.ts` and `src/shared/child-process.ts` for the shape. Both solve
process spawning, which Gofer does not have to solve at all.

## Worked example — adding web search

The second step, after §8. What this briefing already settles:

- **The HTTP call lives in Rust**, as a `ToolDomain` in `ai_tools.rs`. Rust holds the keyring, the
  approval model and `storage/`. `reqwest` is already a dependency (§3).
- **The extraction lives in Node**, in the §8 sub-agent. A model is involved, so it has to (§3).
- **Raw results must not enter the main context** — it holds a live shell and a live editor (§4.1).
  §8 is what makes this possible, which is why it comes first.
- **The API key**: keyring or settings config. Both mechanisms exist in `settings.rs`. Config is
  plaintext on disk; the keyring is not. Pick knowingly.
- **Confinement and approvals do not cover egress.** Decide it explicitly (§4.2, §4.3).
- **Probing needs an amendment, not a `try`** (§4.7).
- **Expect three test failures on purpose**: the closed-catalogue test, the command-surface check,
  and the prompt default test (§4.4, §4.5, §4.6). Each is small and each is the design asking for
  confirmation.
- **Caching goes in `storage/`**, not a second SQLite file (§3).
- pi-task's `pi-worker-search` is the shape to read, not the code to copy. It is its one worker with
  no child process — a direct API call.
