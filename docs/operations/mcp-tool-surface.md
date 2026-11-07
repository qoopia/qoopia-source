# MCP discovery and Code Mode (5.0.24)

An update keeps existing connection URLs, credentials and approvals. Reconnection
is not required. A client that caches tool descriptions may need to refresh its
catalog to show the new helpers.

The default `tools/list` contains `recall`, `note_get`, `note_create`,
`agent_inbox`, `agent_send`, `qoopia_guide`, `tool_search` and `qoopia_execute`.
Profiles and OAuth scopes can reduce this list. `qoopia_protocol` remains visible
for older connection instructions; named connections also expose
`connection_verify` for the setup wizard.

Other tools keep their existing names, argument validation and permissions.
Discover their schemas with `tool_search({query:"session_expand"})`, then call
the returned tool normally. Hooks and integrations that already know a name can
call it directly. A hidden schema does not remove or grant access.

`recall` returns excerpts and identifiers without waiting for a memory model by
default. Use `judge:true` when model judgement is needed. Fetch full bodies with
`note_get({id:"…"})`, or bounded bodies with
`note_get({ids:["…","…"],max_chars:1000})`. Batches accept 1–50 identifiers;
the default per-note limit in a batch is 2,000 characters. Missing and invisible
notes both return `NOT_FOUND`. A single `id` without `max_chars` keeps its full
legacy response.

`qoopia_guide({})` returns a short index. Load a chapter with
`qoopia_guide({section:"safety",language:"en"})` (or `"ru"`). Complete legacy
`qoopia_protocol` calls and local reference documents remain available. Initial
MCP instructions and SessionStart context contain the core rules and references,
with a 2 KiB budget. Larger restored conversations stay in memory; use
`session_expand` or `work_handoff` to read the referenced history.

## Code Mode

`qoopia_execute` takes a `code` string with async JavaScript and a top-level
`return`. For example:

```js
const found = await qoopia.recall({query: "release plan", limit: 10});
const notes = await qoopia.note_get({
  ids: found.results.map(item => item.id),
  max_chars: 800,
});
return notes.notes.filter(note => note.text?.includes("release"));
```

Search may return no matches: check for an empty list before calling a batch.
Use `scope:"notes"` when only note identifiers are wanted. Session results need
`session_expand`, discovered with `tool_search`, instead of `note_get`.

The result contains `result`, `logs` (from `console.log`) and `calls`, with an
untrusted-content label. Each nested call uses the calling agent's ordinary
dispatcher, argument validation, current permissions, profile, OAuth scope and
logging. Only tools classified `read` in that agent's authorized catalog are
exposed. Writes, administrative actions and confirmation requests cannot run.
Normal write tools remain separate calls subject to the usual approval rules.
Read tools with effects beyond reading are not exposed: `qoopia_protocol` and
`qoopia_guide` record connection status and `agent_inbox` records delivery, so
they stay direct calls. Code Mode never spends the owner's model: `recall` runs
with `judge` and `deep_llm` forced off. A remembered text that merely mentions
`APPROVAL_REQUIRED` is data; only an actual tool error refuses a nested call.

Each execution gets a separate QuickJS-WASM runtime with a 10 second deadline,
50 tool calls, 20,000 output bytes, a 32 MiB interpreter heap limit and a 512 KiB
stack limit. It has no host JavaScript access, network, filesystem, timers or
module loader. JavaScript evaluation stays inside QuickJS. Tool data and guest
values cross the boundary as JSON; they never become host code, and only the
guest's `result` crosses, never extra top-level keys. At most four nested calls
run at once; the rest wait in order. A timeout stops the guest and ends the run:
waiting calls never start, and the at most four reads already inside a handler
may finish afterwards without reaching the disposed interpreter. Errors or
exhausted budgets return a tool error rather than a partial success.

## Operator switches

Set these variables in the **server** process environment and restart it:

| Variable | Default | Alternative |
| --- | --- | --- |
| `QOOPIA_TOOL_SURFACE` | `lean` | `classic` lists the complete authorized registry with full schemas |
| `QOOPIA_CODE_MODE` | `on` | `off` removes and disables `qoopia_execute` |

The switches are independent. `classic` is a rollback of discovery presentation,
without a version downgrade or data migration. Both surfaces keep all existing
permission checks. A client with its own Code Mode can use the off switch.
