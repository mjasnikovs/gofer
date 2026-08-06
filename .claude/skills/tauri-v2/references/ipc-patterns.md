# Tauri v2 IPC patterns

## Contents

- Selection guide
- Commands
- Errors and async work
- State
- Events
- Channels
- Security checklist

Official sources: [calling Rust](https://v2.tauri.app/develop/calling-rust/),
[calling the frontend](https://v2.tauri.app/develop/calling-frontend/), and
[state management](https://v2.tauri.app/develop/state-management/).

## Selection guide

| Primitive | Use                                                   | Direction                              |
| --------- | ----------------------------------------------------- | -------------------------------------- |
| Command   | Request/response and fallible operations              | Frontend to Rust, then one response    |
| Event     | Fire-and-forget notification or broadcast             | Either direction, one-way per emission |
| Channel   | Ordered, high-throughput stream tied to an invocation | Rust to frontend                       |

Events use JSON strings and are not intended for high-throughput streaming. Channels preserve order
and can carry arbitrary serializable data.

## Commands

```rust
#[tauri::command]
fn calculate_total(item_count: u32, unit_price: u64) -> Result<u64, String> {
    u64::from(item_count)
        .checked_mul(unit_price)
        .ok_or_else(|| "total overflowed".to_string())
}
```

```ts
import {invoke} from '@tauri-apps/api/core'

const total = await invoke<number>('calculate_total', {
    itemCount: 3,
    unitPrice: 500
})
```

Frontend argument keys are camel-case by default. Use `#[tauri::command(rename_all = "snake_case")]`
only when the caller sends snake-case keys.

Register every command:

```rust
tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![calculate_total])
```

Commands directly in `lib.rs` must not be `pub`. Commands in a separate module must be `pub` and
registered with the module path.

## Errors and async work

Arguments must implement `serde::Deserialize`; returned values and errors must implement
`serde::Serialize`. Prefer structured errors when frontend behavior depends on the error category.

Use async commands for asynchronous or heavy work. Synchronous commands execute on the main thread
unless annotated `#[tauri::command(async)]`. Prefer owned async arguments such as `String`; consult
the official workaround before using borrowed arguments.

Never expose sensitive internals through `err.to_string()` in production IPC responses. Log the
detailed cause on the Rust side and return a stable public code/message.

For large binary responses, `tauri::ipc::Response` avoids JSON serialization overhead. Do not accept
arbitrary frontend paths merely because the response transport is efficient:

```rust
use tauri::ipc::Response;

#[tauri::command]
fn read_export(export_id: String, state: tauri::State<'_, ExportState>) -> Result<Response, String> {
    let path = state.resolve_authorized_export(&export_id)?;
    let bytes = std::fs::read(path).map_err(|_| "export could not be read".to_string())?;
    Ok(Response::new(bytes))
}
```

## State

The type requested through `State<T>` must exactly match the type passed to `.manage(...)`.

```rust
use std::sync::Mutex;
use tauri::State;

struct Counter(u64);

#[tauri::command]
fn increment(counter: State<'_, Mutex<Counter>>) -> Result<u64, String> {
    let mut counter = counter.lock().map_err(|_| "counter unavailable".to_string())?;
    counter.0 += 1;
    Ok(counter.0)
}

// Builder:
// .manage(Mutex::new(Counter(0)))
```

Do not hold a `std::sync::Mutex` guard across `.await`. Use an async mutex only when the protected
operation genuinely must span an await point.

## Events

Import `tauri::Emitter` to emit from Rust and clean up frontend listeners:

```rust
use tauri::Emitter;

#[derive(Clone, serde::Serialize)]
struct SyncFinished {
    changed: usize,
}

fn notify(app: &tauri::AppHandle, changed: usize) -> tauri::Result<()> {
    app.emit("sync-finished", SyncFinished { changed })
}
```

```ts
import {listen} from '@tauri-apps/api/event'

const unlisten = await listen<{changed: number}>('sync-finished', event => {
    console.log(event.payload.changed)
})

// Call during component or application cleanup.
unlisten()
```

Events are global by default. Use window/webview-specific emission when the payload should not be
broadcast.

## Channels

Use a channel for progress or streamed results tied to a command call:

```rust
use tauri::ipc::Channel;

#[derive(Clone, serde::Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase")]
enum ImportEvent {
    Progress {completed: usize, total: usize},
    Finished,
}

#[tauri::command]
async fn import_items(items: Vec<String>, on_event: Channel<ImportEvent>) -> Result<(), String> {
    let total = items.len();
    for (index, item) in items.into_iter().enumerate() {
        import_one(item).await?;
        on_event
            .send(ImportEvent::Progress {completed: index + 1, total})
            .map_err(|_| "progress receiver closed".to_string())?;
    }
    on_event.send(ImportEvent::Finished).map_err(|_| "progress receiver closed".to_string())
}
```

```ts
import {Channel, invoke} from '@tauri-apps/api/core'

type ImportEvent =
    {event: 'progress'; data: {completed: number; total: number}} | {event: 'finished'}

const onEvent = new Channel<ImportEvent>()
onEvent.onmessage = message => console.log(message)
await invoke('import_items', {items, onEvent})
```

## Security checklist

- Treat every frontend argument as untrusted, including bundled frontend input.
- Restrict privileged custom commands through an application manifest when the threat model requires
  it.
- Validate paths, URLs, identifiers, payload size, and authorization in Rust.
- Avoid global events for sensitive payloads.
- Remove listeners when their owner is destroyed.
- Bound stream rates and handle a closed channel without panicking.
- Avoid `unwrap()` in IPC paths where malformed input or lifecycle changes can trigger failure.

Verified against official Tauri v2 documentation on 2026-08-01.
