# MCP tool and response contract

The exact current canonical snapshot is [current-tools.json](contracts/current-tools.json). The full proposed additive snapshot is [proposed-v4-tools.json](contracts/proposed-v4-tools.json). Their source delta, new-tool input schemas, risks, flags, authorization rules, and OAuth mapping are [tool-contract.json](tool-contract.json). Every new-tool result resolves through the draft-07 registry [v4-response-schemas.json](contracts/v4-response-schemas.json), whose `$id` is `https://qoopia.local/contracts/v4-response-schemas.json`; Markdown anchors are not API schemas.

`bun run scripts/v4-contract-snapshot.ts --check` dynamically registers the baseline tool modules against a scratch data root, converts the same Zod input shapes used by MCP into JSON Schema, and proves that the checked-in snapshots match. The proposed snapshot is constructed by adding five optional recall fields and eleven new canonical tools; no baseline required property is removed or changed.

## Envelopes

- Success retains the existing MCP envelope: `content[0].type="text"`; `content[0].text` contains one JSON value.
- Failure retains `isError=true` and stable `CODE: message` text. Internal SQL, stack, token, cookie, path, raw query, and note body details are never returned.
- Pagination uses opaque cursors bound to workspace, caller capability, filters, and stable sort. A cursor replayed under a different scope is `INVALID_ARGUMENT`.
- Idempotency keys are workspace/actor/operation scoped. Reuse with a different canonical request hash is `CONFLICT`.
- `extraction_review(action="edit")` requires `edited_text`; accept/reject rejects edit-only fields. Protected-type accept/edit requires owner/steward capability.

## Authorization freeze

Authorization is an intersection evaluated in this order: authentication, tool profile, OAuth scope, instance role, AuthContext workspace, resource visibility, special capability, then transaction-time recheck. Unknown profile/scope/role/type fails closed and request IDs never select a broader workspace.

| Tool class | Exact minimum |
|---|---|
| `note_relation_list` | authenticated read tool; current workspace; base note visible; both relation endpoints visible; private-note existence is not leaked |
| `note_supersede` | full profile + `mcp:admin` + canonical instance; both notes pass existing mutation/private-owner checks; rechecked inside the transaction |
| extraction reads | caller initiated the run or is owner/steward; source references remain independently authorized |
| extraction preview/review | `mcp:write` or admin on canonical instance; review initiator/owner/steward rule; protected accepts require owner/steward |
| trace read / feedback | trace caller or owner/steward for read; feedback trace must be unexpired, owned by the feedback actor, contain the visible note, and survive the insert transaction; pin/unpin requires owner/steward |
| `export_plan`, `export_bundle`, `import_plan` | all are `admin` risk: full profile, `mcp:admin`, owner/steward, canonical instance, exact AuthContext workspace, and transaction-time recheck |

The machine-readable `authorization` object on each new tool is normative. Export/import plans are deliberately admin-risk even though planning is read-only because counts, artifact discovery, and signing operations are high-sensitivity recovery surfaces.

## Compatibility invariants

Baseline names, input requiredness/defaults, risk classes, OAuth mapping, private/workspace checks, and result fields remain unchanged. Optional additive response fields are ignored by V3 clients. The compatibility overlay remains default-off and frozen; V4 SDKs/CLI/examples use canonical names only.

Export/import tool schemas are frozen in P01/P05. Their service binding lands in P08 under the narrow ownership rule in [ownership.md](ownership.md); any name, input, result, risk, scope, capability, workspace, or instance-role drift reopens P05 review.
