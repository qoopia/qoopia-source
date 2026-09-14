# Memory in V1

Qoopia stays the memory service. Agents work in their own Claude Code/Codex clients;
the dashboard connects their subscription and memory, without a task composer.

## Retrieval

- SQLite FTS5 and bundled multilingual E5-small (384 dimensions, quantized ONNX,
  one CPU worker) retrieve candidates. No Ollama/Jina installation is needed.
- Text is split into overlapping token-bounded passages with query/passage prefixes,
  masked mean pooling and normalized vectors. A content hash fences asynchronous
  writes. Missing/stale chunks are rebuilt from the original notes.
- Workspace and note visibility are checked before ranking or model disclosure.
  With an owner-connected subscription, sparse queries receive bounded expansion,
  existing note relations contribute one hop, and the model judges up to 20 candidates.
- Official Claude Code / Codex clients use the owner's selected subscription.
  No API-key fallback. A disposable HOME and disabled tools keep memory inference
  separate from agent execution. One model process, eight queued requests and a
  45-second inference budget bound resource use. Failed inference returns retrieval
  with explicit judging status. Cloud/subscription latency still applies.
- Existing Ollama and rerank endpoints remain optional compatibility settings.
  The built-in provider is the fresh-install default.

## Session continuity

Connect a native agent from Memory settings. On Mac, open its `.qoopia-memory`
connection file; on Linux run `qoopia memory-link --file /absolute/path/to/file`.
Existing native settings are backed up and unrelated MCP entries/hooks are preserved.
Codex requires one native hook trust review in `/hooks`.

Hooks capture visible user/assistant/tool events from the native transcript. They do
not capture hidden reasoning or binary attachments. The transcript is the durable
source; acknowledged source IDs and byte offsets make retries idempotent. An outage
keeps unacknowledged bytes for the next hook. The native client need not wait for a
summary model response.

One private context note per tracked session preserves the goal, constraints,
decisions, corrections and next step. Summaries update incrementally, retaining
source cursors and revisions. Durable capture starts immediately; useful growth,
time and pre-compaction events trigger summaries. Actual context occupancy (25%)
is an additional signal when the runtime exposes it.

On session start, Qoopia restores an unambiguous ended predecessor from the same
agent/project, plus recent unsummarized events. Simultaneous or ambiguous tasks stay
separate. Restored text is reference material; current instructions take precedence.
A new session cannot infer which of several unrelated prior tasks the user intended.
Browser-only MCP clients retain note/search access but cannot provide automatic
transcript capture or lifecycle injection through MCP alone.

Linux bundles include the small bubblewrap helper used by the official Claude
client, its supporting libraries, notices and corresponding source. The host must
provide glibc 2.34 or newer. Docker includes bubblewrap and standard TLS root
certificates. Host AppArmor and other OS policies remain enabled.

## Evidence and deployment

`bun scripts/qualify-memory.ts` creates a disposable database and runs 48 RU/EN/KK
queries against 12 fixed notes. `--subscription-root ROOT` additionally exercises
real Claude ranking and two context-note revisions; add `--codex` for Codex.
The corpus is a small synthetic qualification, not a production accuracy estimate.

The first real macOS run retrieved the expected note in the top five for 44/48
queries. Six subscribed Claude judgments placed the expected source first; two
checkpoint revisions restored the corrected Corsair decision. Results and measured
latencies are published with the release evidence. Search quality and cloud latency
remain visible limitations, not reasons to keep rerunning the same test.

Schema 38 adds derived chunk storage and context-note uniqueness. Normal startup is
schema-read-only. Back up the authoritative database and stop every reader before
migration; compare all original rows and credentials before accepting new writes.
