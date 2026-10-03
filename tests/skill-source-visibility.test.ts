// ADR-020: a skill draft may cite only notes its author may read — its own, its siblings' shared
// notes while its shared-context toggle is on, and everything for the steward and the owner.
import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { ownerFixture, completeContent, principalAuth } from "./helpers/p1-fixtures.ts";
import { issuePairing, redeemPairing } from "../src/auth/pairings.ts";
import { reviseDraft } from "../src/skills/authority.ts";
import { digest } from "../src/skills/commands.ts";

test("skill draft sources follow the shared-context toggle", () => {
  const { database: d, auth } = ownerFixture();
  try {
    const author = (name: string) => principalAuth(d, redeemPairing(issuePairing(auth, {
      name, runtime_id: "fixture", profile: "skill-author", expected_revision: 1, idempotency_key: name,
    }, d).one_time_code!, d).data.agent_id);
    const [writer, on, off] = [author("Writer"), author("On"), author("Off")];
    d.query("UPDATE agents SET metadata = json_set(metadata, '$.shared_context', json('false')) WHERE id = ?").run(off.agent_id);
    const note = (text: string, visibility: string) => {
      const noteId = randomUUID();
      d.query("INSERT INTO notes(id,workspace_id,agent_id,type,text,visibility) VALUES (?,?,?,'note',?,?)").run(noteId, writer.workspace_id, writer.agent_id, text, visibility);
      return { kind: "note" as const, id: noteId, digest: digest(text) };
    };
    const shared = note("sibling shared source", "workspace"), secret = note("sibling private source", "private");
    const cite = (who: typeof auth, ref: typeof shared, key: string) =>
      () => reviseDraft(who, { slug: `src-${key}`, content: completeContent, expected_revision: 0, source_refs: [ref], idempotency_key: key }, d);

    expect(cite(on, shared, "on-shared")).not.toThrow();
    expect(cite(off, shared, "off-shared")).toThrow("authorized scope");
    expect(cite(on, secret, "on-private")).toThrow("authorized scope");
    expect(cite(auth, secret, "owner-private")).not.toThrow();
  } finally { d.close(); }
});
