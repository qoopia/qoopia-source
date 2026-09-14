// Disposable catalog generation; invoke with --preload ./tests/setup.ts and NODE_ENV=test.
import { writeFileSync, mkdirSync } from "node:fs";
import { ownerFixture, principalAuth } from "../tests/helpers/p1-fixtures.ts";
import { effectiveAuthority } from "../src/api/authority.ts";
import { issuePairing, redeemPairing } from "../src/auth/pairings.ts";
if (process.env.NODE_ENV !== "test") throw new Error("P1 catalog generation requires the isolated test environment");
const { database: d, auth } = ownerFixture();
try {
  const catalog: Record<string, unknown> = { owner: effectiveAuthority(auth, d) };
  let target: string | undefined;
  for (const profile of ["memory-reader", "memory-worker", "skill-author", "skill-reviewer"]) {
    const p = issuePairing(auth, { name: profile, runtime_id: "fixture", profile, expected_revision: 1, idempotency_key: profile }, d);
    const enrolled = redeemPairing(p.one_time_code!, d);
    target ??= enrolled.data.agent_id;
    catalog[profile] = effectiveAuthority(principalAuth(d, enrolled.data.agent_id), d);
  }
  const reporter = redeemPairing(issuePairing(auth, { name: "runtime-reporter", runtime_id: "fixture", profile: "runtime-reporter",
    target_agent_id: target, expected_revision: 1, idempotency_key: "runtime-reporter" }, d).one_time_code!, d);
  catalog["runtime-reporter"] = effectiveAuthority(principalAuth(d, reporter.data.agent_id), d);
  mkdirSync("artifacts/p1", { recursive: true });
  writeFileSync("artifacts/p1/catalog.json", JSON.stringify(catalog, null, 2) + "\n");
  console.log(JSON.stringify({ profiles: Object.keys(catalog), artifact: "artifacts/p1/catalog.json" }));
} finally { d.close(); }
