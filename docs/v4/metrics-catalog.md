# V4 observability catalog

All V4 series live in the process-local `MetricRegistry`, the adapter surface for the sanctioned operator collector. No public metrics endpoint is opened by P08. Labels are closed, low-cardinality enums. IDs, workspace/agent names, raw queries, note/session/message bodies, artifact paths, destination hosts, and error messages are forbidden labels.

| Series | Value | Allowed labels |
|---|---|---|
| `v4_recall_latency_ms` | duration | `mode`, `result` |
| `v4_recall_results` | result count | `mode`, `result` |
| `v4_extraction_outcome_total` | counter | `outcome`, `risk_class` |
| `v4_conflict_total` | counter | `kind` |
| `v4_lifecycle_change_total` | counter | `action`, `result` |
| `v4_agentcomm_delivery_total` | counter | `state`, `error_code` |
| `v4_outbox_enqueued_total` | counter | `event_type` |
| `v4_outbox_delivery_total` | counter | `result`, `error_code` |
| `v4_export_plan_rows` | planned rows | `include_ephemeral` |
| `v4_export_bundle_total` | counter | `result` |
| `v4_import_plan_total` | counter | `result` |
| `v4_migration_status_total` | counter | `status` |

`MetricRegistry` caps labels at eight, label values at 64 bytes, series at 1000, and rejects `*_id`. Structured log contexts use the same no-body/no-secret stance: sensitive keys are redacted, detector hits become `[REDACTED_SECRET]`, strings are bounded, and internal failures return stable error codes to clients.

Instrumentation is wired at the V4 recall response boundary, extraction review and conflict boundaries, lifecycle mutations, AgentComm delivery receipt transitions, schema migration completion, outbox transitions, and export/import planning. Error-code labels are classified rather than emitted verbatim.
