#!/usr/bin/env bun
/**
 * Backlog sweep query — Phase 1 item 2.
 *
 * Extracted from /srv/qoopia/scripts/backlog_sweep.sh so the TypeScript
 * regex and SQL live in a single source file with no shell-escape layers.
 * The bash wrapper invokes this script via `docker exec`.
 *
 * Eligibility (post Leo R3, strict — see /srv/qoopia/docs/backlog-cleanup-policy.md):
 *   A. metadata.superseded_by already present, OR
 *   B. ALL of:
 *      - kind in (request, status)
 *      - age >= 7d
 *      - session.status == 'open'
 *      - topic matches TEST_TOPIC_RE
 *      - a 'reply' row exists in the SAME session with created_at > candidate's
 *
 * Cross-session prefix matching is explicitly NOT used (Leo R3 #2C).
 *
 * Usage:
 *   bun scripts/backlog_sweep_query.ts <dry-run|apply>
 *
 * Exports:
 *   TEST_TOPIC_RE — exported for the unit test.
 */
import { db } from "../src/db/connection.ts";
import { agentSend, agentSessionClose } from "../src/services/agent-comm.ts";

export const TEST_TOPIC_RE =
  /^(?:SMOKE_|.*_PROOF$|.*_TEST_|WAKE_SLO_PROBE_)/;

const WORKSPACE_ID = "01KMKRVYF2FN68D9N3C8BEGAHS";

type Row = {
  id: string;
  session_id: string;
  sender_agent_id: string;
  recipient_agent_id: string;
  kind: string;
  body: string;
  metadata: string;
  delivered_at: string | null;
  created_at: string;
  topic: string;
  session_status: string;
  sender_name: string;
  recipient_name: string;
};

type Decision =
  | { row: Row; outcome: "would_mark"; reason: string }
  | { row: Row; outcome: "skipped"; reason: string };

function classify(row: Row, now: Date): Decision {
  const meta = JSON.parse(row.metadata || "{}");
  if (meta.superseded_by !== undefined || meta.status === "superseded") {
    return { row, outcome: "would_mark", reason: "superseded_by" };
  }

  const ageDays =
    (now.getTime() - new Date(row.created_at).getTime()) / 86_400_000;
  if (ageDays < 7) {
    return { row, outcome: "skipped", reason: "young" };
  }
  if (!TEST_TOPIC_RE.test(row.topic)) {
    return { row, outcome: "skipped", reason: "not_test_topic" };
  }

  // Strict per Leo R3: same-session reply only — no cross-session prefix
  // inference.
  const successor = db
    .prepare(
      `SELECT 1 FROM agent_comm_messages
        WHERE session_id = ? AND kind = 'reply' AND created_at > ?
        LIMIT 1`,
    )
    .get(row.session_id, row.created_at);
  if (!successor) {
    return { row, outcome: "skipped", reason: "no_successor_reply" };
  }
  return { row, outcome: "would_mark", reason: "test_topic_with_successor" };
}

function main() {
  const mode = (process.argv[2] || "").toLowerCase();
  if (mode !== "dry-run" && mode !== "apply") {
    console.error("usage: backlog_sweep_query.ts <dry-run|apply>");
    process.exit(2);
  }
  const apply = mode === "apply";
  const now = new Date();

  const rows = db
    .prepare(
      `SELECT m.id, m.session_id, m.sender_agent_id, m.recipient_agent_id,
              m.kind, m.body, m.metadata, m.delivered_at, m.created_at,
              s.topic, s.status AS session_status,
              sa.name AS sender_name, ra.name AS recipient_name
         FROM agent_comm_messages m
         JOIN agent_comm_sessions s ON s.id = m.session_id
         JOIN agents sa ON sa.id = m.sender_agent_id
         JOIN agents ra ON ra.id = m.recipient_agent_id
        WHERE m.kind IN ('request','status')
          AND s.status = 'open'`,
    )
    .all() as Row[];

  const candidates: Row[] = [];
  const would_mark: Decision[] = [];
  const skipped: Decision[] = [];
  let errors = 0;

  for (const r of rows) {
    candidates.push(r);
    const d = classify(r, now);
    if (d.outcome === "would_mark") would_mark.push(d);
    else skipped.push(d);
  }

  const out: string[] = [];
  out.push("mode: " + (apply ? "apply" : "dry-run"));
  out.push("agents-considered: corsair-main, Leo");
  out.push("candidates: " + candidates.length);
  for (const r of candidates) {
    out.push(
      "  - msg_id=" +
        r.id.slice(-8) +
        "  session=" +
        r.session_id.slice(-8) +
        "  kind=" +
        r.kind +
        "  topic=" +
        r.topic +
        "  age_days=" +
        Math.floor(
          (now.getTime() - new Date(r.created_at).getTime()) / 86_400_000,
        ),
    );
  }
  out.push("would_mark: " + would_mark.length);
  for (const w of would_mark) {
    out.push(
      "  - msg_id=" +
        w.row.id.slice(-8) +
        "  session=" +
        w.row.session_id.slice(-8) +
        "  from=" +
        w.row.sender_name +
        "  to=" +
        w.row.recipient_name +
        "  reason=" +
        w.reason,
    );
  }
  out.push("skipped: " + skipped.length);
  for (const s of skipped) {
    out.push("  - msg_id=" + s.row.id.slice(-8) + "  reason=" + s.reason);
  }

  if (apply) {
    for (const w of would_mark) {
      try {
        agentSend({
          workspace_id: WORKSPACE_ID,
          agent_id: w.row.sender_agent_id,
          to_agent: w.row.recipient_name,
          session_id: w.row.session_id,
          kind: "status",
          body: "superseded_by=time",
          metadata: {
            status: "superseded",
            superseded_by: null,
            by_sweeper: true,
            reason: w.reason,
          },
        });
        agentSessionClose({
          workspace_id: WORKSPACE_ID,
          agent_id: w.row.sender_agent_id,
          session_id: w.row.session_id,
          reason: "superseded",
        });
      } catch (e) {
        errors += 1;
        out.push(
          "  error msg_id=" + w.row.id.slice(-8) + " err=" + String(e),
        );
      }
    }
  }
  out.push("errors: " + errors);
  console.log(out.join("\n"));
}

if (import.meta.main) main();
