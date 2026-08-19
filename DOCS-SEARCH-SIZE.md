# godot_docs_search is 23.5% of all tool output

Measured on the `spawn` project, 2026-08-19. Every number below comes from
`~/hub/spawn/.gofer/project.sqlite`, table `docs_answers` — 130 cached `search` calls, 47 cached
`ask` calls. Reproduction commands are at the bottom.

Two separate faults. One is ours, one is gofer-rag's.

---

## Where the search log actually is

`~/hub/spawn/.gofer/logs/` holds only Godot editor stdout. No search records.

Search history is `docs_answers` in the project sqlite. It is a cache, keyed on
`(corpus_version, mode, lowercased question)`. It stores answers only —
`GodotDocsResponse::is_worth_remembering` refuses to write a dead end. So the cache cannot show
abstains, and its 0-abstain count is not evidence either way.

---

## Fault 1 — we send keyword piles. Ours.

130 of 130 `search` calls were keyword piles. Not one plain question.

```
godot 4.7 node2d global_position node get_index array dictionary clear typed arrays gdscript direct method call
godot 4.7 canvasitem z_index z_as_relative sprite2d frame property modulate color
godot 4.7 node2d area2d timer animatedsprite2d instantiate packedscene signals get_nodes_in_group
```

Mean query length: 10.7 words, almost all of them class and member names.

The tool's own `search` summary asks for the opposite:

> "Retrieves ranked passages for a question in plain words."

`src-tauri/src/ai_tools.rs:627`

`ask` is the control group. It gets both shapes, through the identical retrieval path, so the two
are directly comparable:

| `ask` query shape | n   | mean top score |
| ----------------- | --- | -------------- |
| plain question    | 28  | 2.09           |
| keyword pile      | 19  | 1.72           |

Piles retrieve worse. The rule that produces them is ours:

`src-tauri/src/agent_prompt.rs:45`

> Search godot_docs_search before writing any Godot class, method, signal, property or constant,
> every time, including when the name feels obvious

"every time, before writing any class, method, signal, property or constant" reads as an instruction
to list every name about to be written. The model complies literally and batches them into one call.
That is not a misread — it is what the sentence says.

### What the pile does to retrieval

110 of 130 pile queries name a chapter title verbatim. gofer-rag treats a named title as a fast
path: it skips LLM query expansion and lets `titleSearch` fire
(`gofer-rag/src/core/query.ts:70-84`). So a pile naming six classes pulls six class-reference intro
pages and spends the slot budget one class-intro at a time.

Result: only 39% of returned passages are chapters the query named. Mean 2.00 named chapters out of
5.07 returned. The other 61% is spill.

---

## Fault 2 — the passage count. gofer-rag's.

`config.rerankKeep = 5`, plus up to 3 title pins appended after it (`gofer-rag/src/config.ts`,
`rankCandidates` in `core/query.ts`). Chunks are ~1800 chars. 5 x ~1743 = ~9k chars per call.

Per rank, across all 130 searches:

| rank | mean score | median | scored < 0 | chars | cum % of bytes |
| ---- | ---------- | ------ | ---------- | ----- | -------------- |
| 1    | 2.41       | 2.37   | 0/130      | 220k  | 20%            |
| 2    | 1.58       | 1.58   | 7/130      | 220k  | 40%            |
| 3    | 1.01       | 1.03   | 25/130     | 219k  | 60%            |
| 4    | 0.50       | 0.39   | 44/128     | 211k  | 79%            |
| 5    | 0.08       | -0.06  | 63/125     | 208k  | 98%            |
| 6    | -1.20      | -1.41  | 13/16      | 23k   | 100%           |

Rank 5 is a coin flip. Ranks 4-6 are 40% of every byte the tool has ever returned, and score at or
below zero about half the time.

---

## Fault 3 — our cap already exists, and is dead.

`src-tauri/src/rag.rs:402`

```rust
fn default_max_passages() -> usize { 10 }
```

The worker applies it with a plain slice:

`scripts/rag-retrieve.mjs:110`

gofer-rag never returns more than 8 (5 kept + 3 pins), and never returned more than 6 in practice.
So the 10 never binds. We have been shipping a cap that does nothing.

The companion cap does work. `default_max_text_chars() -> 2000` is why no passage in the whole cache
exceeds 1991 chars.

`maxPassages` is deliberately hidden from the model (`src-tauri/src/tool_params.rs:1186`, `:1199`)
with the note that passage count is the search's own decision. That note is still right. It just
picked a number that concedes the decision entirely.

---

## The fix

**The one-line fix was wrong, and gofer-rag has shipped the right one instead.**

Slicing to 3 does cut ~40% of the bytes. It also cuts every title pin, because a pin always sorts
last — a pin exists precisely because that named chapter's chunk scored below everything the
reranker kept. `slice(0, N)` removes the rescues first, and the pin is worth e2e 95 -> 98/100
(gofer-rag commit `4f6a042`).

gofer-rag 0.2.0 adds `maxPassages`: a hard ceiling applied _before_ pinning, with room reserved for
one pin. Ask for a number instead of slicing and the rescue survives.

Was: `default_max_passages() -> 10`, never binding, and a `slice()` that would have destroyed the
pins if it had.

Is now: a default of 4, passed through to gofer-rag as `maxPassages`, with the slice left in place
as a harmless backstop.

### Why 4 and not 3

Measured by replaying gofer-rag's 83 labelled eval questions through every ceiling, on frozen pools
with no model in the loop (`bun run scripts/ab-cut.ts` in gofer-rag):

| ceiling      | passages/call | share of bytes | labelled cases lost |
| ------------ | ------------- | -------------- | ------------------- |
| none (today) | 4.75          | 100%           | —                   |
| 5            | 4.69          | 99%            | none                |
| **4**        | **3.77**      | **79%**        | **none**            |
| 3            | 2.86          | 60%            | 2                   |
| 2            | 1.93          | 40%            | 6                   |

Four is free. Three costs two labelled cases:

```
paraphrase: How do I make one node notify another when something happens?
realistic:  my game freezes for a second when i load a new level
```

Every reading was identical across three independent captures, so none of it is expansion noise.

Three is still defensible — two cases out of 83 for another 19 points of byte volume. But it is a
trade, and it should be made knowingly rather than inherited from a histogram. Start at 4.

### The pin question is now answerable

Passages come back with `pinned: true` when they were rescued. Carry that through `RankedPassage` in
`rag.rs` and into the `docs_answers` cache, and the open question in this document — whether those
16 rescues in 130 calls mattered — becomes a query rather than a guess.

### What changed — landed 2026-08-19

1. `package.json` — `@mjasnikovs/gofer-rag` at `^0.2.0`. Same commit as the option: against 0.1.3
   `validateOptions` throws `unknown option: maxPassages`, a hard failure rather than a no-op.
2. `scripts/rag-retrieve.mjs` — `maxPassages: request.maxPassages` goes into `retrieve()`. The
   `slice()` stays as a backstop and never binds.
3. `src-tauri/src/rag.rs` — `max_passages` is now `Option<usize>`, resolved by `passages_for()` to
   `DEFAULT_PASSAGES = 4`. A caller who names a number still wins, which is what keeps the desktop
   Docs panel at its own bound.
4. `protocol/schemas/v2/params.json` — the hidden-parameter note, which the generator copies into
   `tool_params.rs`. Editing the Rust copy fails `check:command-surface`.
5. `scripts/rag-retrieve.test.mjs` — asserts the stub receives `maxPassages: 4`, and that a chunk
   marked `pinned` comes back marked.

Two deviations from the plan above.

**One default, not one per mode.** An earlier pass gave `search` 3 and `ask` 5, on the reasoning
that an ask's passages are evidence for prose rather than the answer, so thinning them risks an
abstain. The 83-question eval answers that directly: the two cases a ceiling of 3 costs are exactly
the questions an ask would have had to abstain on, and 4 costs none. So what makes 4 safe for a
search makes it safe for an ask, and the split was an unmeasured hedge.

**The pin flag is carried.** `RankedPassage` gained `pinned: Option<bool>`, filled from the chunk
and stored in `docs_answers`. It was listed as answerable rather than as work; it is four lines, and
without it the next version of this document has the same open question.

Verified against the real package and the real corpus, not a stub:

```
maxPassages=undefined  passages=5  chars=7727
maxPassages=4          passages=4  chars=6723
```

The version bump is also the cache flush. `corpusVersion()` reads the gofer-rag package version and
`docs_answers` is keyed on it — confirmed: all 177 rows in `spawn` are keyed `0.1.3` and the worker
now reports `0.2.0`, so every one of them is unreachable and refills at the new size. Nothing prunes
the old rows; they stay in sqlite as dead weight.

### Not the fix

Raising `rerankThreshold` is gofer-rag's call, not ours. For the record: it is -4, and the worst
passage ever kept scored -3.96 — the gate is loose enough that a passage nearly at the floor still
shipped. Whether it ever fires is not answerable from this cache, because a 0-passage response is
not worth-remembering and is never written. Measure it in gofer-rag against its own off-topic eval
set, not here.

### Separately, the prompt

Fault 1 is not fixed by the cap. Capping to 3 makes a bad query cheaper, not better.
`agent_prompt.rs:45` needs to stop reading as "list every name you are about to write" and start
reading as "ask one question about the thing you are unsure of". That is a prose change with no
measurement behind it yet, so it should land on its own, after the cap, where its effect on
retrieval scores can be seen.

---

## Reproducing

```sh
cd ~/hub/spawn/.gofer

# every search query, largest response first
sqlite3 -noheader project.sqlite \
  "select length(response_json)||' | '||question from docs_answers
   where mode='search' order by length(response_json) desc limit 40;"

# passages per call, and chars per passage
sqlite3 -noheader project.sqlite \
  "select response_json from docs_answers where mode='search';" |
python3 -c "
import sys,json,statistics as s
ns=[];per=[]
for line in sys.stdin:
    p=json.loads(line)['passages']
    ns.append(len(p)); per += [len(x['text']) for x in p]
print('calls',len(ns),'passages/call mean %.2f'%s.mean(ns))
print('passage chars mean %d max %d'%(s.mean(per),max(per)))
"

# the per-rank table above
sqlite3 -noheader project.sqlite \
  "select response_json from docs_answers where mode='search';" |
python3 -c "
import sys,json,statistics as s
byrank={};chars={}
for line in sys.stdin:
    for i,p in enumerate(sorted(json.loads(line)['passages'],key=lambda x:-x['score'])):
        byrank.setdefault(i,[]).append(p['score'])
        chars.setdefault(i,[]).append(len(p['text']))
tot=sum(sum(v) for v in chars.values()); run=0
for i in sorted(byrank):
    v=byrank[i]; c=sum(chars[i]); run+=c
    print('rank%d n=%3d mean=%6.2f median=%6.2f <0:%3d/%3d chars=%7d cum%%=%.0f'
          %(i+1,len(v),s.mean(v),s.median(v),sum(1 for x in v if x<0),len(v),c,100*run/tot))
"
```
