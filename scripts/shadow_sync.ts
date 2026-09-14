#!/usr/bin/env bun
/**
 * Shadow sync CLI — invoked by the operator wrapper under
 * $QOOPIA_ROOT/scripts.
 *
 * Phase 2 Item B (plan note 01KSC0E9F1WFWJMSP58KS34H2A).
 *
 * Dry-run (default) is STRICTLY read-only against both DBs. The only
 * side-effect is writing the markdown report under $QOOPIA_ROOT/logs/.
 *
 * --apply mode is GATED by a short-lived, HMAC-signed authorization manifest
 * bound to the exact plan + database paths + Qoopia review/owner approval IDs.
 * The signing secret comes from SHADOW_SYNC_APPLY_AUTHORIZED (minimum 32 bytes).
 *
 * No production invocation is authorized by this artifact. Apply remains an
 * owner-operated action after independent review and explicit approval.
 *
 * Usage:
 *   bun /app/scripts/shadow_sync.ts \
 *       --mac-db "$QOOPIA_ROOT/backups/mac-mini-snapshot-<ts>.db" \
 *       --cor-db "$QOOPIA_ROOT/data/qoopia.db" \
 *       [--report-out "$QOOPIA_ROOT/logs/shadow-sync-dryrun-<ts>.md"] \
 *       [--apply --authorization-manifest <path>]
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ulid } from "ulid";
import { env } from "../src/utils/env.ts";
import {
  buildPlan,
  renderReport,
  writeReport,
  reportBodyHash,
  checkApplyGate,
  applyPlan,
  renderApplyReport,
  createApplyAuthorizationManifest,
  planFingerprint,
  type ApplyAuthorizationManifest,
} from "../src/services/shadow_sync.ts";

type Args = {
  macDb: string;
  corDb: string;
  reportOut?: string;
  apply: boolean;
  authorizationManifest?: string;
  prepareManifestOut?: string;
  reviewId?: string;
  ownerApprovalId?: string;
  expiresMinutes: number;
};

function parseArgs(argv: string[]): Args {
  const out: Args = {
    macDb: "",
    corDb: path.join(env.DATA_DIR, "qoopia.db"),
    apply: false,
    expiresMinutes: 15,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--mac-db":
        out.macDb = argv[++i];
        break;
      case "--cor-db":
        out.corDb = argv[++i];
        break;
      case "--report-out":
        out.reportOut = argv[++i];
        break;
      case "--apply":
        out.apply = true;
        break;
      case "--dry-run":
        out.apply = false;
        break;
      case "--authorization-manifest":
        out.authorizationManifest = argv[++i];
        break;
      case "--prepare-authorization-manifest":
        out.prepareManifestOut = argv[++i];
        break;
      case "--review-id":
        out.reviewId = argv[++i];
        break;
      case "--owner-approval-id":
        out.ownerApprovalId = argv[++i];
        break;
      case "--expires-minutes":
        out.expiresMinutes = Number(argv[++i]);
        break;
      case "-h":
      case "--help":
        printHelp();
        process.exit(0);
      default:
        console.error(`unknown arg: ${a}`);
        printHelp();
        process.exit(2);
    }
  }
  return out;
}

function printHelp() {
  console.error(
    [
      "usage: shadow_sync.ts --mac-db <path> [--cor-db <path>] [--report-out <path>]",
      "                     [--apply --authorization-manifest <path>]",
      "                     [--prepare-authorization-manifest <path>",
      "                      --review-id <qoopia-ulid> --owner-approval-id <qoopia-ulid>]",
      "",
      "  --mac-db          path to Mac mini DB snapshot (read-only)",
      "  --cor-db          path to Corsair DB (default: /data/qoopia.db, read-only in dry-run)",
      "  --report-out      where to write the markdown report",
      "                    (default: /logs/shadow-sync-dryrun-<utc>.md)",
      "  --apply           requires a valid signed authorization manifest.",
      "  --authorization-manifest",
      "                    signed, plan-bound manifest for this apply run.",
      "  --prepare-authorization-manifest",
      "                    write a signed manifest after review + owner approval.",
      "  --review-id / --owner-approval-id",
      "                    Qoopia ULIDs embedded in a prepared manifest.",
      "  --expires-minutes manifest TTL; default 15, maximum 60.",
      "  --dry-run         default; strictly read-only against both DBs.",
    ].join("\n"),
  );
}

function utcTsLabel(): string {
  const d = new Date();
  const iso = d.toISOString().replace(/[:.]/g, "").replace(/-/g, "");
  return iso.slice(0, 15) + "Z"; // YYYYMMDDTHHMMSSZ
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.macDb) {
    console.error("error: --mac-db is required");
    printHelp();
    process.exit(2);
  }

  const tsLabel = utcTsLabel();
  const plan = buildPlan(args.macDb, args.corDb);

  if (args.prepareManifestOut) {
    if (args.apply) {
      console.error("HOLD: manifest preparation and --apply are separate operations");
      process.exit(3);
    }
    if (!args.reviewId || !args.ownerApprovalId) {
      console.error(
        "HOLD: manifest preparation requires --review-id and --owner-approval-id Qoopia ULIDs",
      );
      process.exit(3);
    }
    if (!Number.isFinite(args.expiresMinutes) || args.expiresMinutes <= 0 || args.expiresMinutes > 60) {
      console.error("HOLD: --expires-minutes must be between 1 and 60");
      process.exit(3);
    }
    const issuedAt = new Date();
    const manifest = createApplyAuthorizationManifest({
      secret: process.env.SHADOW_SYNC_APPLY_AUTHORIZED ?? "",
      plan,
      macDbPath: args.macDb,
      corDbPath: args.corDb,
      runId: ulid(),
      reviewId: args.reviewId,
      ownerApprovalId: args.ownerApprovalId,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(
        issuedAt.getTime() + args.expiresMinutes * 60_000,
      ).toISOString(),
    });
    writeFileSync(args.prepareManifestOut, JSON.stringify(manifest, null, 2) + "\n", {
      mode: 0o600,
    });
    chmodSync(args.prepareManifestOut, 0o600);
    console.log(
      `authorization manifest prepared path=${args.prepareManifestOut} ` +
        `run_id=${manifest.run_id} plan_sha256=${manifest.plan_sha256} ` +
        `expires_at=${manifest.expires_at}`,
    );
    return;
  }

  if (args.apply) {
    let manifest: ApplyAuthorizationManifest | undefined;
    if (args.authorizationManifest) {
      try {
        manifest = JSON.parse(
          readFileSync(args.authorizationManifest, "utf8"),
        ) as ApplyAuthorizationManifest;
      } catch (error) {
        console.error(`HOLD: cannot read authorization manifest: ${String(error)}`);
        process.exit(3);
      }
    }
    const gateErr = checkApplyGate({
      apply: true,
      envToken: process.env.SHADOW_SYNC_APPLY_AUTHORIZED,
      manifest,
      plan,
      macDbPath: args.macDb,
      corDbPath: args.corDb,
    });
    if (gateErr) {
      console.error(gateErr);
      process.exit(3);
    }

    const applyReportOut =
      args.reportOut ?? `/logs/shadow-sync-apply-${tsLabel}.md`;
    const result = applyPlan(plan, {
      macDbPath: args.macDb,
      corDbPath: args.corDb,
      direction: "M2C",
    });

    // Post-apply verify: re-run the planner and assert the applied direction is
    // now empty (parity). Mac source is read-only throughout.
    const verifyPlan = buildPlan(args.macDb, args.corDb);
    const residualNotesM2c = verifyPlan.notes.filter((c) => c.direction === "M2C").length;
    const residualActivityM2c = verifyPlan.activity.filter((c) => c.direction === "M2C").length;
    const parityOk = residualNotesM2c === 0 && residualActivityM2c === 0;

    const applyReport = renderApplyReport(result, tsLabel, {
      residualNotesM2c,
      residualActivityM2c,
    });
    writeReport(applyReport, applyReportOut);

    console.log(
      `apply ${parityOk ? "OK" : "PARITY_FAIL"} report=${applyReportOut} ` +
        `direction=M2C tx=${result.transaction} ` +
        `notes_inserted=${result.notes.inserted} notes_updated=${result.notes.updated} ` +
        `notes_hashes=${result.notes.hashesRecorded} notes_skipped=${result.notes.skippedIdempotent} ` +
        `act_inserted=${result.activity.inserted} act_hashes=${result.activity.hashesRecorded} ` +
        `act_skipped=${result.activity.skippedIdempotent} ` +
        `post_apply_m2c_notes=${residualNotesM2c} post_apply_m2c_activity=${residualActivityM2c}`,
    );
    if (!parityOk) process.exit(6);
    return;
  }

  const reportOut = args.reportOut ?? `/logs/shadow-sync-dryrun-${tsLabel}.md`;

  const report = renderReport(plan, tsLabel);
  writeReport(report, reportOut);

  // Stdout summary for the operator + cron logs (no body bytes per rubric §7).
  const m2cN = plan.notes.filter((c) => c.direction === "M2C").length;
  const c2mN = plan.notes.filter((c) => c.direction === "C2M").length;
  const conflicts = [...plan.notes, ...plan.activity].filter(
    (c) => c.direction === "conflict",
  ).length;
  const m2cA = plan.activity.filter((c) => c.direction === "M2C").length;
  const c2mA = plan.activity.filter((c) => c.direction === "C2M").length;
  const noopN = plan.notes.filter((c) => c.direction === "noop").length;
  const bodyHash = reportBodyHash(report);
  console.log(
    `dry-run OK report=${reportOut} notes_m2c=${m2cN} notes_c2m=${c2mN} conflicts=${conflicts} notes_noop=${noopN} act_m2c=${m2cA} act_c2m=${c2mA} report_body_sha256=${bodyHash} plan_sha256=${planFingerprint(plan)}`,
  );
}

if (import.meta.main) main();
