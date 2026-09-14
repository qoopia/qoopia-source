import { Database } from "bun:sqlite";
import { reviseDraft, reviewSkill } from "../../src/skills/authority.ts";
const request = JSON.parse(await Bun.file(process.argv[3]!).text());
const d = new Database(process.argv[2]!);
d.run("PRAGMA foreign_keys=ON"); d.run("PRAGMA busy_timeout=5000");
console.log("ready");
for await (const _ of Bun.stdin.stream()) {
  try { const result = (request.operation === "review" ? reviewSkill : reviseDraft)(request.auth, request.input, d); console.log(JSON.stringify({ status: 200, revision: result.revision })); }
  catch (error) { console.log(JSON.stringify({ status: 409, code: (error as { code?: string }).code })); }
  break;
}
d.close();
