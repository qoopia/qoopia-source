/**
 * Phase 2 Item C — smoke driver. Stands up a brand-new sqlite DB in
 * /tmp, runs every migration on disk against it (so 021/022 land on a
 * clean schema), then exercises the entity service to encode the
 * three Item C entities + two participants links and prints their
 * IDs and a recall sample. Pure /tmp — production DB is NEVER touched.
 *
 *   QOOPIA_DATA_DIR=/tmp/phase2c-<stamp> bun run scripts/phase2_item_c_smoke.ts
 *
 * Output is consumed by the Leo review packet so the immutable
 * reference can quote concrete IDs. No DB writes anywhere else.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// IMPORTANT: redirect DATA_DIR BEFORE importing anything from /app/src
// — connection.ts reads env at module load.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "phase2c-"));
process.env.QOOPIA_DATA_DIR = path.join(root, "data");
process.env.QOOPIA_LOG_DIR = path.join(root, "logs");
process.env.QOOPIA_BACKUP_DIR = path.join(root, "backups");
process.env.QOOPIA_LOG_LEVEL = process.env.QOOPIA_LOG_LEVEL ?? "error";
process.env.QOOPIA_RECALL_MODE = "hybrid";
// Phase 2 Item C R2 — recall+MCP entity surface is feature-flagged OFF
// in production until Leo final PASS + Asхат GO. The smoke driver
// MUST explicitly opt in or the entity channel short-circuits and
// acceptance criteria (a)–(d) cannot be exercised.
process.env.QOOPIA_ENTITY_PAGES = "true";

const { runMigrations } = await import("../src/db/migrate.ts");
const { createWorkspace } = await import("../src/admin/workspaces.ts");
const {
  upsertEntity,
  addLink,
  searchEntities,
  renderEntityPage,
} = await import("../src/services/entities.ts");
const { recall } = await import("../src/services/recall.ts");

runMigrations();
const ws = createWorkspace({
  name: "Phase 2 Item C smoke",
  slug: "p2c-smoke",
});

const acProtocol = upsertEntity({
  workspace_id: ws.id,
  type: "protocol",
  slug: "agentcomm-protocol",
  title: "AgentComm durable inbox and wake protocol",
  summary: [
    "AgentComm is the inter-agent message bus that powers Qoopia's",
    "multi-agent coordination layer (Phase 0 decisions §4).",
    "",
    "Happy path: agent_session_create → agent_send →",
    "recipient agent_reply → sender close.",
    "",
    "Loop-prevention rule (mandatory): close with `CORSAIR_LOOP_TERMINATE`",
    "after the final substantive reply so Leo's auto-echo doesn't fan out",
    "into infinite ack/reply cycles.",
    "",
    "Failure modes: F1 optional wake delivery failed, F2 ack timeout, F3 reply",
    "error envelope, F4 orphaned session, F5 duplicate request.",
  ].join("\n"),
  metadata: {
    spec_doc:
      "Phase 0 decisions §4 (note 01KSBJVWFKVPX9P4R2DB8R2TX1)",
    source_note_ids: ["01KSBJVWFKVPX9P4R2DB8R2TX1"],
    participants: ["corsair-main", "leo"],
  },
});

const corsair = upsertEntity({
  workspace_id: ws.id,
  type: "agent",
  slug: "corsair-main-agent",
  title: "corsair-main (Corsair Ductor assistant)",
  summary: [
    "Primary Ductor assistant on the Corsair host. Coordinates",
    "multi-agent work, owns the Qoopia MCP write surface for this",
    "agent identity, and hosts the Phase 1/2 audit/hardening work.",
    "",
    "Reads SoT from Qoopia entity pages; refreshes per-session",
    "MAINMEMORY from `recall(<top entity names>)` at start.",
  ].join("\n"),
  metadata: {
    host: "corsair@100.74.112.61",
    workspace: "~/.ductor-corsairmain",
    framework: "ductor",
    mcp_servers: ["qoopia-corsair"],
  },
});

const leo = upsertEntity({
  workspace_id: ws.id,
  type: "agent",
  slug: "leo-agent",
  title: "Leo (Hermes reviewer)",
  summary: [
    "Independent reviewer for Phase 1/2 work. Runs on the Mac mini",
    "via the Hermes framework. Triggers dual-review on Phase 0",
    "decisions §5 conditions.",
    "",
    "AgentComm dispatch is event-triggered (no polling) per the Phase",
    "2 Item D contract; ack-SLA target ≤ 60s online, ≤ 5min if",
    "asleep with wake-push.",
  ].join("\n"),
  metadata: {
    host: "mac-mini-askhat",
    framework: "hermes-leo",
    role: "reviewer",
    dispatch: "event-triggered",
  },
});

const link1 = addLink({
  workspace_id: ws.id,
  source_entity_id: acProtocol.id,
  target_entity_id: corsair.id,
  relation_type: "participants",
});
const link2 = addLink({
  workspace_id: ws.id,
  source_entity_id: acProtocol.id,
  target_entity_id: leo.id,
  relation_type: "participants",
});

// Phase 2 Item C R2 — seed a stub `agentcomm-e2e-skill` entity so
// acceptance criterion (d) can run end-to-end inside Item C without
// waiting for Item E. The stub is a placeholder; Item E owns the full
// skill encoding (skill_upsert / render_runbook tooling). Metadata
// flags item_e_stub=true so the Item E migration can find and replace
// it cleanly when the time comes.
const e2eSkill = upsertEntity({
  workspace_id: ws.id,
  type: "skill",
  slug: "agentcomm-e2e-skill",
  title: "AgentComm E2E skill (Item E stub)",
  summary:
    "Placeholder seeded by Phase 2 Item C R2 to satisfy acceptance " +
    "criterion (d) (entity_link + render verification). Full skill " +
    "encoding lands in Item E with skill_upsert / render_runbook " +
    "tooling — until then this stub serves as the link target so " +
    "the documents relation between agentcomm-protocol and the " +
    "AgentComm-E2E skill is exercised end-to-end inside Item C.",
  status: "active",
  metadata: {
    item_e_stub: true,
    encoded_by: "item-c-r2",
    encoded_at: new Date().toISOString(),
    superseded_by_phase: "Phase 2 Item E (fat skills layer)",
  },
});

const link3 = addLink({
  workspace_id: ws.id,
  source_entity_id: acProtocol.id,
  target_entity_id: e2eSkill.id,
  relation_type: "documents",
  confidence: 1.0,
  source: "item-c-r2-stub",
});

const searchHits = searchEntities({
  workspace_id: ws.id,
  query: "AgentComm",
  limit: 5,
});

const recallResult = await recall({
  workspace_id: ws.id,
  caller_agent_id: "smoke-driver",
  is_admin: false,
  query: "AgentComm protocol",
  limit: 10,
});

const renderResult = renderEntityPage({
  workspace_id: ws.id,
  slug: "agentcomm-protocol",
});

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

const payload = {
  workspace_id: ws.id,
  workspace_slug: ws.slug,
  entities: [
    { slug: acProtocol.slug, id: acProtocol.id, type: acProtocol.type },
    { slug: corsair.slug, id: corsair.id, type: corsair.type },
    { slug: leo.slug, id: leo.id, type: leo.type },
    { slug: e2eSkill.slug, id: e2eSkill.id, type: e2eSkill.type, item_e_stub: true },
  ],
  links: [
    {
      link_id: link1.link_id,
      relation: `${acProtocol.slug} --participants--> ${corsair.slug}`,
    },
    {
      link_id: link2.link_id,
      relation: `${acProtocol.slug} --participants--> ${leo.slug}`,
    },
    {
      link_id: link3.link_id,
      relation: `${acProtocol.slug} --documents--> ${e2eSkill.slug}`,
      source: "item-c-r2-stub",
    },
  ],
  entity_search_hits: searchHits.map((h) => ({
    slug: h.slug,
    type: h.type,
    rank: h.rank,
  })),
  recall_hits_top5: recallResult.results.slice(0, 5).map((r: any) => ({
    source: r.source,
    type: r.type,
    slug: r.slug,
    id: typeof r.id === "string" ? r.id.slice(0, 12) + "…" : r.id,
    rank: r.rank,
  })),
  render_markdown_sha256: sha256(renderResult.markdown),
  render_markdown_bytes: renderResult.markdown.length,
  render_truncated: renderResult.truncated,
  render_shows_participants:
    renderResult.markdown.includes("**participants**"),
  render_shows_documents:
    renderResult.markdown.includes("**documents**") &&
    renderResult.markdown.includes("agentcomm-e2e-skill"),
};

console.log(JSON.stringify(payload, null, 2));
console.log("---RENDER MARKDOWN START---");
console.log(renderResult.markdown);
console.log("---RENDER MARKDOWN END---");

// Cleanup
fs.rmSync(root, { recursive: true, force: true });
