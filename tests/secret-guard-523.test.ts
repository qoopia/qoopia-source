/**
 * 5.0.23 (Alan's comparison with ai-memory): key formats with no detector, passwords written as prose
 * in English and Russian, long random strings, and a turn that keeps its text when a secret is cut out.
 * Fake values are assembled from parts so secret scanners do not read this file as a leak.
 */
import { beforeAll, expect, test } from "bun:test";
import { assertNoSecrets, detectSecretLabels, highEntropy, redactMemory } from "../src/utils/secret-guard.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { createWorkspace } from "../src/admin/workspaces.ts";
import { createAgent } from "../src/admin/agents.ts";
import { saveMessage, saveTurn } from "../src/services/sessions.ts";
import { db } from "../src/db/connection.ts";

const google = "AI" + "za" + "Sy" + "Ab12Cd34Ef56Gh78Ij90Kl12Mn34Op56Q";
const telegram = "123456789" + ":" + "AA" + "Hd3k9QwErTyUiOpAsDfGhJkLzXcVbNm12";
const gitlab = "glp" + "at-" + "AbCdEf1234567890xYzQ";
const npm = "np" + "m_" + "aB3dE5fG7hI9jK1lM3nO5pQ7rS9tU1vW3xY5";
const hf = "h" + "f_" + "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh";

test("Google, Telegram, GitLab, npm and Hugging Face tokens are found and cut out", () => {
  for (const [label, token] of [["google-api-key", google], ["telegram-bot-token", telegram], ["gitlab-pat", gitlab], ["npm-token", npm], ["huggingface-token", hf]]) {
    expect(detectSecretLabels(`key ${token} here`)).toContain(label);
    expect(redactMemory(`key ${token} here`).text).toBe(`key [REDACTED:${label}] here`);
  }
  // Look-alikes in ordinary text stay.
  for (const text of ["hf_model_name_for_the_classifier_v2", "npm_config_registry", "glpat- prefix is GitLab's", "12:30 meeting at 123456789"])
    expect(detectSecretLabels(text)).toEqual([]);
});

test("a password written as prose is found in English and Russian; only the value goes", () => {
  const value = "hunter2-" + "FAKE";
  const cases: Array<[string, string]> = [
    [`the admin password is ${value}`, "the admin password is [REDACTED:password]"],
    [`DB password is "correct horse battery"`, "DB password is [REDACTED:password]"],
    [`пароль: ${value}`, "пароль: [REDACTED:password]"],
    [`Пароль от почты — Kz2024!${"x"}`, "Пароль от почты — [REDACTED:password]"],
    [`пароль такой: ${value}`, "пароль такой: [REDACTED:password]"],
    [`код доступа: 4815-1623`, "код доступа: [REDACTED:password]"],
  ];
  for (const [text, expected] of cases) {
    expect(detectSecretLabels(text)).toContain("password");
    expect(redactMemory(text).text).toBe(expected);
  }
  // Prose about passwords, references and the policy itself stay writable.
  for (const text of ["password is required", "пароль — смотри в 1Password", "Пароль не храним в заметках", "password = process.env.DB_PASSWORD",
    "пароль: ${DB_PASS}", "the passwd file is /etc/passwd", "пароль: [REDACTED:password]"])
    expect(detectSecretLabels(text)).not.toContain("password");
  expect(() => assertNoSecrets(`пароль: ${value}`, "note.text")).toThrow("password");
});

test("long random strings are cut out of captured memory; digests, ids, paths and identifiers stay", () => {
  const random = "Xk7" + "Qm2PzR9vL4tB8nW1cY6hJ3sD5fG0aE2u";
  expect(highEntropy(random)).toBe(true);
  expect(redactMemory(`session secret ${random} end`).text).toBe("session secret [REDACTED:high-entropy] end");
  for (const kept of [
    "6f58b5623c635b9f2eafdefe5ea7ce3363421608",
    "cc917e320fb53f39f1537a72b14537357e0e8ff7d6d73e1d44074ae9c76824e5",
    "01a13bb0-fa72-75f3-9eaa-310955d1ae7d",
    "01M5MJ2P5DVKK4S14Y9D26J0SW",
    "src/services/continuity.ts/withoutProcessorEcho",
    "ReactComponentRendererFactoryForTests2026",
    "qoopia-owner-preview-523-fdea5126ab4dce077ea66e",
  ]) expect(redactMemory(`x ${kept} y`).text).toBe(`x ${kept} y`);
  // Not a refusal for explicit writes: a note may hold a long document id.
  expect(() => assertNoSecrets(`doc ${random}`, "note.text")).not.toThrow();
});

let workspace = "", agent = "";
beforeAll(() => {
  runMigrations();
  const ws = createWorkspace({ name: "Secrets 523", slug: "secrets-523" });
  workspace = ws.id; agent = createAgent({ name: "secrets-523-agent", workspaceSlug: ws.slug }).id;
});

test("session_save with a secret keeps the turn: the secret is cut out and reported, not the whole turn refused", () => {
  const saved = saveMessage({ workspace_id: workspace, agent_id: agent, session_id: "secrets-523-a", role: "user",
    content: `Деплой готов. Ключ ${gitlab}, пароль: hunter2-${"FAKE"}. Дальше — тесты.` });
  expect(saved).toMatchObject({ saved: true, redacted: ["gitlab-pat", "password"] });
  const row = db.query("SELECT content FROM session_messages WHERE id=?").get(saved.id) as { content: string };
  expect(row.content).toBe("Деплой готов. Ключ [REDACTED:gitlab-pat], пароль: [REDACTED:password]. Дальше — тесты.");
  // The one-call turn form keeps both messages too.
  const turn = saveTurn({ workspace_id: workspace, agent_id: agent, session_id: "secrets-523-b", user: `мой токен ${telegram}`, assistant: "Принял, не сохраняю его." });
  expect(turn).toMatchObject({ saved: true });
  const rows = db.query("SELECT role,content FROM session_messages WHERE session_id='secrets-523-b' ORDER BY id").all();
  expect(rows).toEqual([{ role: "user", content: "мой токен [REDACTED:telegram-bot-token]" }, { role: "assistant", content: "Принял, не сохраняю его." }]);
});
