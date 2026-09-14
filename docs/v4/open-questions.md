# Open questions boundary

There are no owner-only product or implementation questions for P02 through P09. Architecture, schema, flags, compatibility, ranking, lifecycle, extraction, security, export/DR, benchmarks, ownership, and acceptance gates are frozen.

Only P10/P11 decisions remain owner-bound:

1. production mutation window and any reduction of the default 24-hour ring observations;
2. the live-resolved canary identity;
3. SDK/tag/release/push publication;
4. any external event-webhook endpoint/recipient/egress enablement;
5. any separate token rotation or agent deactivation action.

Defaults are no production mutation, no publication, external webhooks off, and no token/agent changes. None blocks offline implementation or qualification through P09.
