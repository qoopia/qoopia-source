/**
 * V-N1 regression: the six key forms swept across the note corpus must be
 * refused at the *write path*, not merely redacted after the fact.
 *
 * Evidence trail: 01KYRGKFRC16J7F9MERA0R603A (corpus sweep) measured that a
 * `Bearer ` + 40-char token and an `sk-or-v1-…` OpenRouter key were accepted
 * by `note_create`, while `sk-ant-…` was refused. The follow-up
 * (01KYSPPRM9VGXKT1X1WD3RE03E) redacted the stored value but left the filter
 * unchanged, so the same token written today would still be persisted. These
 * tests pin the filter itself.
 *
 * Every token below is SYNTHETIC. They carry a `VN1FAKE` infix specifically so
 * that no value here can ever be mistaken for, or reused as, a real credential.
 */
import { describe, expect, test } from "bun:test";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { createNote, updateNote } from "../src/services/notes.ts";
import { detectSecretLabels } from "../src/utils/secret-guard.ts";
import { QoopiaError } from "../src/utils/errors.ts";
import { beforeAll } from "bun:test";

let WORKSPACE_ID = "";
let AGENT_ID = "";

beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({ name: "VN1 Guard", slug: "vn1-guard" });
  WORKSPACE_ID = ws.id;
  AGENT_ID = createAgent({ name: "vn1-guard-tester", workspaceSlug: ws.slug }).id;
});

// --- the six corpus forms, synthetic ---------------------------------------

const FORMS: Array<{ form: string; label: string; sample: string }> = [
  {
    form: "qoopia q_",
    label: "qoopia-token",
    sample: "q_VN1FAKEqoopiakey0123456789abcdef",
  },
  {
    form: "github PAT",
    label: "github-pat",
    sample: "ghp_VN1FAKE0123456789abcdefGHIJKLMNOPQRSTuv",
  },
  {
    form: "AWS AKIA",
    label: "aws-access-key-id",
    sample: "AKIAVN1FAKEEXAMPLE00",
  },
  {
    form: "sk-ant (Anthropic)",
    label: "anthropic-key",
    sample: "sk-ant-api03-VN1FAKE-0000000000000000000000000000000000000000AA",
  },
  {
    form: "sk-or-v1 (OpenRouter)",
    label: "openrouter-key",
    sample:
      "sk-or-v1-vn1fake0123456789abcdef0123456789abcdef0123456789abcdef01",
  },
  {
    form: "Bearer + 20",
    label: "bearer-token",
    sample: "Bearer VN1FAKEbearertoken0123456789abcdefghijkl",
  },
];

describe("V-N1 six corpus forms — detector coverage", () => {
  test.each(FORMS.map((f) => [f.form, f.label, f.sample] as const))(
    "%s is detected as %s",
    (_form, label, sample) => {
      expect(detectSecretLabels(sample)).toContain(label);
    },
  );
});

describe("V-N1 six corpus forms — write path refuses a freshly written token", () => {
  test.each(FORMS.map((f) => [f.form, f.label, f.sample] as const))(
    "note_create refuses %s in note.text",
    (_form, label, sample) => {
      let thrown: unknown;
      try {
        createNote({
          workspace_id: WORKSPACE_ID,
          agent_id: AGENT_ID,
          text: `V-N1 write-path probe: ${sample}`,
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(QoopiaError);
      expect((thrown as QoopiaError).code).toBe("INVALID_INPUT");
      expect((thrown as Error).message).toContain(label);
      // the refusal must never echo the value back
      expect((thrown as Error).message).not.toContain(sample);
    },
  );

  test.each(FORMS.map((f) => [f.form, f.sample] as const))(
    "note_create refuses %s in note.metadata",
    (_form, sample) => {
      expect(() =>
        createNote({
          workspace_id: WORKSPACE_ID,
          agent_id: AGENT_ID,
          text: "V-N1 metadata probe",
          metadata: { captured: sample },
        }),
      ).toThrow(QoopiaError);
    },
  );

  test("note_update refuses a secret introduced after creation", () => {
    const note = createNote({
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      text: "V-N1 update probe: clean at creation time",
    });
    expect(() =>
      updateNote({
        workspace_id: WORKSPACE_ID,
        agent_id: AGENT_ID,
        id: note.id,
        text: `now with ${FORMS[5]!.sample}`,
      }),
    ).toThrow(QoopiaError);
    expect(() =>
      updateNote({
        workspace_id: WORKSPACE_ID,
        agent_id: AGENT_ID,
        id: note.id,
        text: `now with ${FORMS[4]!.sample}`,
      }),
    ).toThrow(QoopiaError);
  });
});

describe("V-N1 truncated variants", () => {
  test.each([
    [
      "OpenRouter cut to 16 payload chars",
      "sk-or-v1-vn1fake0123456789",
      "openrouter-key",
    ],
    [
      "OpenRouter cut to 8 payload chars (documented floor)",
      "sk-or-v1-vn1fake0",
      "openrouter-key",
    ],
    [
      "Bearer cut to 24 payload chars",
      "Bearer VN1FAKEbearer0123456789ab",
      "bearer-token",
    ],
    [
      "GitHub PAT cut to 24 payload chars",
      "ghp_VN1FAKE0123456789abcdefGH",
      "github-pat",
    ],
    [
      "Anthropic key cut to 15 payload chars",
      "sk-ant-api03-VN1FAKE00",
      "anthropic-key",
    ],
  ])("%s is still detected", (_name, sample, label) => {
    expect(detectSecretLabels(sample)).toContain(label);
  });

  test.each([
    // Documented, deliberate truncation floors. Below these lengths the
    // fragment is no longer a usable credential and matching would start
    // scrubbing placeholders and prose. See secret-guard.ts §truncation.
    //
    // One case per floor listed in that block — a later broadening of a
    // pattern cannot silently erase one of these decisions without a failure.
    ["sk-or-v1.. placeholder (no payload)", "sk-or-v1..", "openrouter-key"],
    ["Bearer with a 13-char payload", "Bearer VN1FAKE0123", "bearer-token"],
    ["AKIA prefix without the 16-char body", "AKIA1234", "aws-access-key-id"],
    ["q_ with a 12-char payload", "q_VN1FAKE012", "qoopia-token"],
    ["OpenAI sk- with a 19-char payload", "sk-VN1FAKE0123456789", "openai-key"],
    [
      "JWT with two segments and no signature",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJWTjFGQUtFIn0",
      "jwt",
    ],
    [
      "github_pat_ with a 19-char payload",
      "github_pat_VN1FAKE0123456789",
      "github-fine-grained-pat",
    ],
  ])("%s is deliberately NOT detected (documented floor)", (_name, sample, label) => {
    expect(detectSecretLabels(sample)).not.toContain(label);
  });
});

/**
 * The 40 -> 12 floor drop on `anthropic-key` was necessary (the real truncated
 * fragment in note 01KNYZGDDK0Q6097MHBTFXYT7T is 22 chars and the old floor
 * missed it) but a flat 12-char floor also refused ordinary lowercase
 * identifiers on write. The payload is now gated on shape as well as length.
 * These tests pin both directions of that trade at once, so nobody can relax
 * the over-trigger fix by re-widening the pattern and losing real keys.
 */
describe("V-N1 anthropic floor — shape gate keeps real keys, drops word identifiers", () => {
  test.each([
    ["full key with api03 version marker", "sk-ant-api03-VN1FAKE0000000000000000000000000000000000000000AA"],
    ["22-char truncated api03 fragment (the corpus shape)", "sk-ant-api03-VN1FAKE00"],
    ["short api03 fragment, 4 chars past the marker", "sk-ant-api03-VN1F"],
    ["api04 marker (future version)", "sk-ant-api04-VN1FAKE0000000000"],
    ["no marker but mixed case and digits", "sk-ant-VN1FAKE0123456789abcdef"],
    ["no marker, uppercase run", "sk-ant-VN1FAKEUPPERCASEBODY"],
    ["underscore after the version marker", "sk-ant-api03_VN1FAKE00"],
  ])("still detects %s", (_name, sample) => {
    expect(detectSecretLabels(sample)).toContain("anthropic-key");
  });

  test.each([
    ["sk-ant-documentation", "sk-ant-documentation"],
    ["sk-ant-api-reference", "sk-ant-api-reference"],
    ["sk-ant-short (below the old floor too)", "sk-ant-short"],
    ["sk-ant-design", "sk-ant-design"],
    ["sk-ant-integration-guide", "sk-ant-integration-guide"],
    ["prose mentioning the prefix", "The sk-ant-documentation page lists every header."],
  ])("no longer refuses %s", (_name, sample) => {
    expect(detectSecretLabels(sample)).not.toContain("anthropic-key");
  });

  test("the ordinary identifiers are accepted by the note write path", () => {
    for (const sample of [
      "sk-ant-documentation",
      "sk-ant-api-reference",
      "sk-ant-integration-guide",
    ]) {
      expect(() =>
        createNote({
          workspace_id: WORKSPACE_ID,
          agent_id: AGENT_ID,
          text: `see ${sample} for the header list`,
        }),
      ).not.toThrow();
    }
  });
});

/**
 * `github-fine-grained-pat` is a detector this change introduces, not a floor
 * adjustment: `gh[pousr]_` never matched `github_pat_…` at all. Pin it at the
 * write path in both directions.
 */
describe("V-N1 github fine-grained PAT detector", () => {
  const FG_PAT =
    "github_pat_VN1FAKE0123456789ABCDEF_vn1fake0123456789abcdefGHIJKLMNOP";

  test("is detected", () => {
    expect(detectSecretLabels(FG_PAT)).toContain("github-fine-grained-pat");
  });

  test("note_create refuses it in note.text", () => {
    let thrown: unknown;
    try {
      createNote({
        workspace_id: WORKSPACE_ID,
        agent_id: AGENT_ID,
        text: `fine-grained PAT probe: ${FG_PAT}`,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(QoopiaError);
    expect((thrown as QoopiaError).code).toBe("INVALID_INPUT");
    expect((thrown as Error).message).toContain("github-fine-grained-pat");
    expect((thrown as Error).message).not.toContain(FG_PAT);
  });

  test("note_create refuses it in note.metadata", () => {
    expect(() =>
      createNote({
        workspace_id: WORKSPACE_ID,
        agent_id: AGENT_ID,
        text: "fine-grained PAT metadata probe",
        metadata: { captured: FG_PAT },
      }),
    ).toThrow(QoopiaError);
  });

  test("a payload under the floor is accepted at the write path", () => {
    expect(() =>
      createNote({
        workspace_id: WORKSPACE_ID,
        agent_id: AGENT_ID,
        text: "the github_pat_ prefix is documented in docs/operations",
      }),
    ).not.toThrow();
  });
});

describe("V-N1 false-positive guards — ordinary content is not scrubbed", () => {
  const BENIGN: Array<[string, string]> = [
    ["git commit sha", "release_sha=526edaf13746d7e7705cdcb0678b5925c8e14791"],
    [
      "sha256 digest",
      "sha256 b897fdf4ff9b933bea0bea160468cc5892a6ebc423d9875b8b5ebaa62f1a15e4",
    ],
    ["ULID note id", "See note 01KYRGKFRC16J7F9MERA0R603A for the sweep."],
    [
      "several ULIDs in prose",
      "Plan 01KYRF94VS9VXNV3ANTYAJXP3T, handoff 01KYT9PWGG4VDQJRZHDNZBPQ2M.",
    ],
    ["UUID", "trace id 3f2504e0-4f89-11d3-9a0c-0305e82c3301"],
    [
      "base64 png data uri",
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    ],
    [
      "prose containing the word bearer",
      "The bearer of this authorization must present identification on arrival.",
    ],
    [
      "capitalised Bearer followed by ordinary words",
      "Bearer authentication_required for the dashboard endpoints.",
    ],
    [
      "Bearer described without a value",
      "We rotated the Bearer token and stored it outside Qoopia.",
    ],
    [
      "already-redacted bearer line",
      "ТОКЕН: Bearer [REDACTED] (в /tmp/gis2_token.json, ~48ч, эфемерно).",
    ],
    [
      "hyphenated lowercase phrase after Bearer",
      "Bearer token-based-authentication-scheme is documented in docs/.",
    ],
    ["long unicode prose", "обычный текст без секретов ".repeat(40)],
    [
      "file path with long segments",
      "/srv/qoopia/release-evidence/v-a-20260730T031758Z/org-before.txt",
    ],
    [
      "docker image reference",
      "image fc7bb5900ba9 candidate qoopia-candidate:526edaf schema32",
    ],
  ];

  test.each(BENIGN)("%s is not flagged", (_name, text) => {
    expect(detectSecretLabels(text)).toEqual([]);
  });

  test("benign content is accepted by the note write path", () => {
    for (const [name, text] of BENIGN) {
      expect(() =>
        createNote({
          workspace_id: WORKSPACE_ID,
          agent_id: AGENT_ID,
          text: `${name}: ${text}`,
        }),
      ).not.toThrow();
    }
  });
});
