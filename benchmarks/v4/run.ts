import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, arch, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mean, ndcgAtK, percentile, recallAtK, reciprocalRank, stableResultSignature } from "./metrics.ts";

type Case = {
  id: string;
  split: "train" | "dev" | "holdout";
  category: string;
  language: string;
  kind: "note" | "semantic" | "supersede" | "conflict" | "entity" | "private" | "workspace" | "provenance";
  query: string;
  document: string;
  head?: string;
  heads?: string[];
  forbidden?: string;
};

type SeededCase = Case & { relevant_ids: string[]; forbidden_ids: string[]; stale_ids: string[] };

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(name);
  return at >= 0 ? (process.argv[at + 1] ?? fallback) : fallback;
}

function enabled(name: string): boolean {
  return process.argv.includes(name);
}

function positiveInts(value: string): number[] {
  const numbers = value.split(",").map(Number);
  if (!numbers.length || numbers.some((value) => !Number.isInteger(value) || value < 1 || value > 10)) {
    throw new Error("--scales must contain integers from 1 through 10");
  }
  return [...new Set(numbers)];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const baselineName = arg("--baseline", "v3");
const candidateName = arg("--candidate", "v4-flags-off");
const scales = positiveInts(arg("--scales", "1,10"));
const runs = Number(arg("--runs", "3"));
const requestedSeed = Number(arg("--seed", "400"));
const output = arg("--json", "artifacts/v4/evidence/P09/report.json");
const holdoutOnly = enabled("--holdout");
if (baselineName !== "v3") throw new Error("only the frozen v3 baseline is supported");
if (!new Set(["v4-flags-off", "v4-flags-on"]).has(candidateName)) throw new Error("unsupported candidate");
if (!Number.isInteger(runs) || runs < 3 || runs > 20) throw new Error("--runs must be 3..20");
if (requestedSeed !== 400) throw new Error("P09 corpus seed is frozen at 400");

const corpusPath = join(import.meta.dir, "corpus.json");
const corpusText = readFileSync(corpusPath, "utf8");
const corpus = JSON.parse(corpusText) as {
  format: string;
  version: string;
  seed: number;
  cases: Case[];
  qualification_cases: Array<{ id: string; category: string; test: string }>;
};
if (corpus.format !== "qoopia-v4-qualification-corpus/1" || corpus.seed !== requestedSeed) {
  throw new Error("corpus contract mismatch");
}
const cases = corpus.cases.filter((item) => !holdoutOnly || item.split === "holdout");
if (!cases.length) throw new Error("selected corpus is empty");

const scratch = mkdtempSync(join(tmpdir(), "qoopia-p09-"));
process.env.NODE_ENV = "test";
process.env.QOOPIA_DATA_DIR = join(scratch, "data");
process.env.QOOPIA_LOG_DIR = join(scratch, "logs");
process.env.QOOPIA_BACKUP_DIR = join(scratch, "backups");
process.env.QOOPIA_LOG_LEVEL = "error";
process.env.QOOPIA_AUTO_EMBED = "false";
process.env.QOOPIA_ENTITY_PAGES = "true";
process.env.QOOPIA_SERVER_ROLE = "canonical";
process.env.QOOPIA_INSTANCE_ID = "p09-offline-qualification";

const dimensionByQuery = new Map(cases.map((item, index) => [item.query, index + 1]));
const embedStub = Bun.serve({
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/embed") {
      const body = await request.json() as { input?: string };
      const vector = new Array(1024).fill(0);
      const matched = [...dimensionByQuery].find(([query]) => String(body.input ?? "").includes(query));
      vector[matched?.[1] ?? 1000] = 1;
      return Response.json({ model: "bge-m3", embeddings: [vector] });
    }
    if (url.pathname === "/rerank") return new Response("offline fallback fixture", { status: 503 });
    return new Response("not found", { status: 404 });
  },
});
process.env.QOOPIA_EMBED_ENDPOINT = `http://127.0.0.1:${embedStub.port}/api/embed`;
process.env.QOOPIA_RERANK_JINA_ENDPOINT = `http://127.0.0.1:${embedStub.port}/rerank`;
process.env.QOOPIA_EMBED_TIMEOUT_MS = "1000";
process.env.QOOPIA_RERANK_TIMEOUT_MS = "1000";

const { runMigrations } = await import("../../src/db/migrate.ts");
const { db } = await import("../../src/db/connection.ts");
const { createWorkspace } = await import("../../src/admin/workspaces.ts");
const { createAgent } = await import("../../src/admin/agents.ts");
const { createNote } = await import("../../src/services/notes.ts");
const { createNoteRelation } = await import("../../src/services/note-relations.ts");
const { createNoteProvenance } = await import("../../src/services/provenance.ts");
const { upsertEntity } = await import("../../src/services/entities.ts");
const { saveMessage } = await import("../../src/services/sessions.ts");
const { createExtractionRun, reviewExtractionCandidate } = await import("../../src/services/extraction.ts");
const { EMBED_DIM, EMBED_MODEL, serializeEmbedding } = await import("../../src/services/embeddings.ts");
const { recall, recallBaseline } = await import("../../src/services/recall.ts");

runMigrations();

function seedEmbedding(table: "notes_embeddings" | "entity_embeddings", id: string, workspaceId: string, dimension: number) {
  const vector = new Float32Array(EMBED_DIM);
  vector[dimension] = 1;
  const idColumn = table === "notes_embeddings" ? "note_id" : "entity_id";
  // Fixture vectors still need the live source hash: recall rejects stale indexes.
  const source = table === "notes_embeddings"
    ? (db.query("SELECT text FROM notes WHERE id=?").get(id) as {text:string}).text
    : (() => { const e = db.query("SELECT title,summary,slug FROM entity_pages WHERE id=?").get(id) as {title:string;summary:string|null;slug:string}; return `${e.title}\n\n${e.summary ?? ''}\n\nslug:${e.slug}`; })();
  db.prepare(
    `INSERT INTO ${table} (${idColumn}, workspace_id, embedding, dim, model, text_hash)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, workspaceId, serializeEmbedding(vector), EMBED_DIM, EMBED_MODEL, sha256(source));
}

function authFor(agent: { id: string; name: string }, workspaceId: string) {
  return { agent_id: agent.id, agent_name: agent.name, workspace_id: workspaceId, type: "standard", source: "api-key" as const };
}

function seedCase(item: Case, index: number, scale: number, workspaceId: string, agent: { id: string; name: string }, sibling: { id: string; name: string }): SeededCase {
  const dimension = dimensionByQuery.get(item.query)!;
  const auth = authFor(agent, workspaceId);
  const relevant: string[] = [];
  const forbidden: string[] = [];
  const stale: string[] = [];
  const note = (text: string, owner = agent.id, visibility: "workspace" | "private" = "workspace") => {
    const created = createNote({ workspace_id: workspaceId, agent_id: owner, text, type: "memory", visibility });
    seedEmbedding("notes_embeddings", created.id, workspaceId, dimension);
    return created;
  };

  if (item.kind === "entity") {
    const entity = upsertEntity({
      workspace_id: workspaceId,
      type: "service",
      slug: `p09-${scale}-${index}-${item.id}`,
      title: item.document,
      summary: `qualification entity ${item.id}`,
    });
    seedEmbedding("entity_embeddings", entity.id, workspaceId, dimension);
    relevant.push(entity.id);
  } else if (item.kind === "supersede" || item.kind === "conflict") {
    const old = note(item.document);
    stale.push(old.id);
    const heads = item.kind === "supersede" ? [item.head!] : item.heads!;
    for (const text of heads) {
      const head = note(text);
      relevant.push(head.id);
      createNoteRelation({ auth, source_note_id: head.id, target_note_id: old.id, relation_type: "supersedes" });
    }
  } else {
    const created = note(item.document);
    relevant.push(created.id);
    if (item.kind === "provenance") {
      createNoteProvenance({
        auth,
        note_id: created.id,
        source_kind: "manual",
        source_id: `p09:${item.id}`,
        source_hash: sha256(item.document),
        confidence: 1,
      });
    }
    if (item.kind === "private") {
      forbidden.push(note(item.forbidden!, sibling.id, "private").id);
    }
    if (item.kind === "workspace") {
      const foreignWorkspace = createWorkspace({ name: `P09 foreign ${scale} ${index}`, slug: `p09-foreign-${scale}-${index}` });
      const foreignAgent = createAgent({ name: `p09-foreign-agent-${scale}-${index}`, workspaceSlug: foreignWorkspace.slug });
      const foreign = createNote({ workspace_id: foreignWorkspace.id, agent_id: foreignAgent.id, text: item.forbidden!, type: "memory" });
      seedEmbedding("notes_embeddings", foreign.id, foreignWorkspace.id, dimension);
      forbidden.push(foreign.id);
    }
  }
  return { ...item, relevant_ids: relevant, forbidden_ids: forbidden, stale_ids: stale };
}

function setCandidateFlags(on: boolean) {
  for (const name of ["QOOPIA_V4_RELATIONS", "QOOPIA_V4_LATEST_ONLY", "QOOPIA_V4_RECALL_EXPLAIN", "QOOPIA_V4_LIFECYCLE"]) {
    if (on) process.env[name] = "true";
    else delete process.env[name];
  }
}

function qualifyExtraction(scale: number, workspaceId: string, agent: { id: string; name: string }) {
  const auth = authFor(agent, workspaceId);
  const sessionId = `p09-extraction-${scale}`;
  const acceptedMessage = saveMessage({
    workspace_id: workspaceId, agent_id: agent.id, session_id: sessionId,
    role: "user", content: `P09 accepted extraction source ${scale}`,
  });
  const rejectedMessage = saveMessage({
    workspace_id: workspaceId, agent_id: agent.id, session_id: sessionId,
    role: "user", content: `P09 rejected extraction source ${scale}`,
  });
  const beforeProposal = (db.prepare(`SELECT COUNT(*) AS c FROM notes WHERE workspace_id = ?`).get(workspaceId) as { c: number }).c;
  const run = createExtractionRun({
    auth,
    session_id: sessionId,
    source_start_id: acceptedMessage.id!,
    source_end_id: rejectedMessage.id!,
    extractor_version: `p09-qualification-${scale}`,
    prompt_hash: sha256(`p09-extraction-prompt:${scale}`),
    candidates: [
      { text: `P09 accepted extraction fact ${scale}`, type: "knowledge", source_message_ids: [acceptedMessage.id!], confidence: 1 },
      { text: `P09 rejected extraction fact ${scale}`, type: "knowledge", source_message_ids: [rejectedMessage.id!], confidence: 0.5 },
    ],
  });
  const afterProposal = (db.prepare(`SELECT COUNT(*) AS c FROM notes WHERE workspace_id = ?`).get(workspaceId) as { c: number }).c;
  const accepted = reviewExtractionCandidate({ auth, candidate_id: run.candidates[0]!.id, action: "accept", expected_version: 0 });
  const rejected = reviewExtractionCandidate({ auth, candidate_id: run.candidates[1]!.id, action: "reject", expected_version: 0 });
  const afterReview = (db.prepare(`SELECT COUNT(*) AS c FROM notes WHERE workspace_id = ?`).get(workspaceId) as { c: number }).c;
  return {
    proposals: 2,
    accepted: accepted.candidate.status === "accepted" ? 1 : 0,
    rejected: rejected.candidate.status === "rejected" ? 1 : 0,
    acceptance_rate: accepted.candidate.status === "accepted" ? 0.5 : 0,
    rejection_rate: rejected.candidate.status === "rejected" ? 0.5 : 0,
    false_auto_writes: afterProposal - beforeProposal,
    explicit_review_writes: afterReview - afterProposal,
    pass: afterProposal === beforeProposal && afterReview === afterProposal + 1,
  };
}

async function executeVariant(name: string, seeded: SeededCase[], workspaceId: string, agentId: string) {
  const isBaseline = name === "v3";
  const isOn = name === "v4-flags-on";
  setCandidateFlags(isOn);
  const rows: Array<Record<string, unknown>> = [];
  for (const item of seeded) {
    const params = {
      workspace_id: workspaceId,
      caller_agent_id: agentId,
      is_admin: false,
      query: item.query,
      scope: item.kind === "entity" ? "all" as const : "notes" as const,
      mode: isOn ? "hybrid" as const : "fts5" as const,
      limit: 5,
      ...(isOn ? { latest_only: true, explain: true, lifecycle: true } : {}),
    };
    const invoke = () => isBaseline ? recallBaseline(params) : recall(params);
    await invoke();
    const latencies: number[] = [];
    let response: Awaited<ReturnType<typeof recallBaseline>> | null = null;
    for (let run = 0; run < runs; run++) {
      const started = performance.now();
      response = await invoke();
      latencies.push(performance.now() - started);
    }
    const ids = response!.results.map((row) => row.id);
    const forbiddenSet = new Set(item.forbidden_ids);
    const staleSet = new Set(item.stale_ids);
    rows.push({
      case_id: item.id,
      category: item.category,
      language: item.language,
      retrieved_ids: ids,
      relevant_ids: item.relevant_ids,
      recall_at_5: recallAtK(ids, item.relevant_ids, 5),
      reciprocal_rank: reciprocalRank(ids, item.relevant_ids),
      ndcg_at_5: ndcgAtK(ids, item.relevant_ids, 5),
      exact_fact: ids[0] !== undefined && item.relevant_ids.includes(ids[0]) ? 1 : 0,
      leakage_hits: ids.filter((id) => forbiddenSet.has(id)).length,
      stale_hits: ids.filter((id) => staleSet.has(id)).length,
      latency_ms: latencies,
      context_tokens: response!.cost.tokens_returned,
      response_mode: response!.mode,
    });
  }
  const category = (category: string) => rows.filter((row) => row.category === category);
  const categoryRecall = (categoryName: string) => mean(category(categoryName).map((row) => Number(row.recall_at_5)));
  const latencies = rows.flatMap((row) => row.latency_ms as number[]);
  const signatureRows = rows.map((row) => ({ case_id: String(row.case_id), ids: row.retrieved_ids as string[] }));
  return {
    name,
    cases: rows,
    result_signature_sha256: sha256(stableResultSignature(signatureRows)),
    quality: {
      recall_at_5: mean(rows.map((row) => Number(row.recall_at_5))),
      mrr: mean(rows.map((row) => Number(row.reciprocal_rank))),
      ndcg_at_5: mean(rows.map((row) => Number(row.ndcg_at_5))),
      exact_fact: mean(rows.map((row) => Number(row.exact_fact))),
      exact_lexical_recall_at_5: categoryRecall("exact_lexical"),
      semantic_paraphrase_recall_at_5: categoryRecall("semantic_paraphrase"),
      mixed_ru_en_recall_at_5: categoryRecall("mixed_ru_en"),
      stale_surfacing: rows.reduce((sum, row) => sum + Number(row.stale_hits), 0) / Math.max(1, seeded.filter((row) => row.stale_ids.length).length),
      leakage: rows.reduce((sum, row) => sum + Number(row.leakage_hits), 0),
    },
    latency_ms: {
      samples: latencies.length,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      p99: percentile(latencies, 0.99),
    },
    token_efficiency: {
      context_tokens_per_query: mean(rows.map((row) => Number(row.context_tokens))),
      answer_accuracy: mean(rows.map((row) => Number(row.recall_at_5))),
      top_k: 5,
    },
  };
}

const scaleReports: Array<Record<string, unknown>> = [];
try {
  for (const scale of scales) {
    const workspace = createWorkspace({ name: `P09 scale ${scale}`, slug: `p09-scale-${scale}` });
    const agent = createAgent({ name: `p09-agent-${scale}`, workspaceSlug: workspace.slug });
    const sibling = createAgent({ name: `p09-sibling-${scale}`, workspaceSlug: workspace.slug });
    const seeded = cases.map((item, index) => seedCase(item, index, scale, workspace.id, agent, sibling));
    for (let index = 0; index < 50 * scale; index++) {
      createNote({ workspace_id: workspace.id, agent_id: agent.id, text: `deterministic background row ${scale} ${index}`, type: "memory" });
    }
    const baseline = await executeVariant("v3", seeded, workspace.id, agent.id);
    const candidate = await executeVariant(candidateName, seeded, workspace.id, agent.id);
    const extraction = qualifyExtraction(scale, workspace.id, agent);
    const flagsOffIdentical = candidateName !== "v4-flags-off" || baseline.result_signature_sha256 === candidate.result_signature_sha256;

    setCandidateFlags(false);
    const fallbackCase = seeded.find((item) => item.category === "exact_lexical")!;
    const priorEndpoint = process.env.QOOPIA_EMBED_ENDPOINT;
    process.env.QOOPIA_EMBED_ENDPOINT = "http://127.0.0.1:1/api/embed";
    const fallback = await recallBaseline({
      workspace_id: workspace.id, caller_agent_id: agent.id, is_admin: false,
      query: fallbackCase.query, scope: "notes", mode: "hybrid", limit: 5,
    });
    process.env.QOOPIA_EMBED_ENDPOINT = priorEndpoint;

    scaleReports.push({
      scale,
      corpus_rows: (db.prepare(`SELECT COUNT(*) AS c FROM notes WHERE workspace_id = ?`).get(workspace.id) as { c: number }).c,
      baseline,
      candidate,
      extraction,
      flags_off_bit_identical: flagsOffIdentical,
      fallback: { embedder_unavailable_mode: fallback.mode, result_count: fallback.results.length, pass: fallback.mode === "fts5-fallback" && fallback.results.length > 0 },
    });
  }
  const report = {
    format: "qoopia-v4-qualification-report/1",
    generated_at: new Date().toISOString(),
    network: "offline-loopback-fixture-only",
    corpus: { format: corpus.format, version: corpus.version, sha256: sha256(corpusText), seed: corpus.seed, holdout_only: holdoutOnly, cases: cases.length },
    comparison: { baseline: baselineName, candidate: candidateName, scales, runs, warmups_per_case: 1 },
    environment: { bun: Bun.version, platform: platform(), arch: arch(), cpus: cpus().length, cpu_model: cpus()[0]?.model ?? "unknown" },
    qualification_coverage: corpus.qualification_cases,
    extraction: {
      false_auto_writes: scaleReports.reduce((sum, item) => sum + Number((item.extraction as { false_auto_writes: number }).false_auto_writes), 0),
      acceptance_rate: mean(scaleReports.map((item) => Number((item.extraction as { acceptance_rate: number }).acceptance_rate))),
      rejection_rate: mean(scaleReports.map((item) => Number((item.extraction as { rejection_rate: number }).rejection_rate))),
      pass: scaleReports.every((item) => (item.extraction as { pass: boolean }).pass),
      evidence: "proposal-only counts plus explicit accept/reject state transitions; full-suite domain tests remain a second gate",
    },
    scale_reports: scaleReports,
  };
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ output, corpus_sha256: report.corpus.sha256, scales: scaleReports.length, candidate: candidateName }));
} finally {
  embedStub.stop();
  db.close();
  rmSync(scratch, { recursive: true, force: true });
}
