# V4 threat-model delta

This delta extends the accepted V3 controls; it does not replace OAuth, tool-profile, instance-role, workspace/private, secret-guard, dashboard, or backup safety boundaries.

| Threat | Preventive control | Detection / test | Stop condition |
|---|---|---|---|
| Cross-workspace relation or provenance | composite note/workspace FKs plus service authorization | migration FK and workspace-isolation tests | any cross-workspace row or read |
| Private candidate leak through explain/trace | authorization before expansion/diagnostics; caller/admin trace ACL | private competitor and trace redaction fixtures | any hidden ID/count/score leakage |
| Stale resurrection after bounded retrieval | active-head expansion before top-k; fail on graph cap; explicit multiple heads | chain/property/graph-limit tests | stale hit removed without head/conflict |
| Supersede cycle or silent multi-head choice | transaction cycle check; explicit conflict surface | seeded property tests and concurrent head creation | cycle accepted or one head chosen silently |
| Extraction poisoning/hallucination | risk flags, provenance, proposal-only state machine, explicit review | adversarial transcript corpus | automatic canonical write |
| Candidate/trace secret persistence | `assertNoSecrets`, size caps, query hash, no raw hidden candidate | seeded synthetic canaries | any canary in candidate/trace/log/outbox |
| Lifecycle suppresses or leaks protected truth | exhaustive metadata predicate and 0.85 floor; caller-relative confidence uses visible provenance only; history always available | rule/finance/legal/incident/runbook and two-caller provenance fixtures | protected negative decay, hidden-source score influence, or deletion path |
| Trace expiry breaks feedback FK or deletes feedback | nullable trace reference plus one `BEGIN IMMEDIATE` detach/items/header transaction | expiry, rollback injection, concurrent feedback, FK check | feedback loss, partial detach/delete, or FK failure |
| Feedback privilege escalation | visibility re-check; pin/unpin capability check in transaction | profile/OAuth/alias bypass tests | unauthorized pin/unpin |
| Compatibility-overlay bypass | frozen risk classes and instance/OAuth gates; no V4 additions | schema/risk diff and alias-bypass suite | any weaker risk or V4 capability |
| AgentComm replay/duplicate | unique message/consumer receipt, lease, idempotent transition | crash-before/after ACK and transport replay matrix | duplicate ACK/reply/external effect |
| Wake mistaken for delivery | ledger-first contract and same-session ACK/reply/close evidence | wake-failure E2E | wake-only success accepted |
| Export exfiltration | owner/admin risk, sanctioned root, 0700/0600, opaque response | path/permission/content scans | bundle bytes/path escape in response |
| Import tampering or identity merge | Ed25519, SHA-256, format/schema gate, explicit conflict plan | corrupt/missing/duplicate/unknown-version cases | unchecked apply or silent identity merge |
| Event webhook SSRF | flag off, destination ID allowlist, DNS/IP revalidation, no redirects/private ranges | IPv4/IPv6/DNS-rebind corpus | private/link-local request possible |
| Dashboard CSRF/XSS/double-submit | existing cookie/origin/CSRF/CSP/escape plus optimistic version | API/browser synthetic security suite | privilege leak or unsafe action/render |
| Resource exhaustion | pagination, 50 retrieval/channel, graph cap 1000/1000, trace/candidate size and retention caps | abuse/load fixtures at 1x/10x | unbounded query/write path |
| Role/name staleness | AuthContext plus live entity lookup at rollout | literal scan and live manifest evidence | committed canary/fleet name list |

## Data minimization

- Trace headers store query SHA-256, options, IDs, timings, and counts; no raw query.
- Trace items exist only for caller-visible final/expanded candidates.
- Provenance stores source hashes and opaque locators, not excerpts.
- Outbox and receipts store IDs, state, provider proof, and non-secret error codes; no duplicated bodies.
- Evidence artifacts store counts, schemas, hashes, timings, and internal IDs only.

Any workspace/private/secret leak, automatic extraction write, OAuth/profile bypass, legacy write, non-idempotent migration, or duplicate delivery side effect blocks the phase regardless of other test results.
