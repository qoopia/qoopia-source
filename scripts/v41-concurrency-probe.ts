/**
 * Одиночный конкурирующий писатель для доказательства §10.4 «two concurrent
 * same-version -> 1 PASS + 1 STALE_VERSION».
 *
 * ЗАЧЕМ отдельный процесс. Цикл `for` в одном процессе и на одном соединении
 * доказывает только последовательный порядок проверок версии — реальной
 * гонки за строку там нет. Здесь каждый писатель — собственный процесс с
 * собственным соединением SQLite; синхронизация — файловый барьер, поэтому
 * оба доходят до условного UPDATE в одном окне.
 *
 * Печатает одну строку JSON: `{"label":…,"outcome":"PASS"|"STALE_VERSION"|…}`.
 */
import fs from "node:fs";

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error(`--${name} is required`);
  }
  return process.argv[index + 1]!;
}

const label = arg("label");
const workspaceId = arg("workspace");
const agentId = arg("agent");
const predecessorId = arg("predecessor");
const expectedVersion = Number(arg("version"));
const barrier = arg("barrier");

process.env.QOOPIA_V4_BITEMPORAL = "1";

const { createNote } = await import("../src/services/notes.ts");

/** Соединение и все prepared-statement'ы прогреты ДО барьера. */
fs.writeFileSync(`${barrier}.ready.${label}`, "ready");
const deadline = Date.now() + 30_000;
while (!fs.existsSync(`${barrier}.go`)) {
  if (Date.now() > deadline) throw new Error("barrier timeout");
}

function busy(error: unknown): boolean {
  const message = String((error as Error)?.message ?? error);
  return /database is locked|SQLITE_BUSY|database table is locked/i.test(message);
}

let outcome = "UNKNOWN";
let lastError = "";
// Повтор ТОЛЬКО на SQLITE_BUSY/BUSY_SNAPSHOT и ТОЙ ЖЕ ожидаемой версией:
// занятость файла — не исход протокола, а проигранная версия — исход.
// `BEGIN DEFERRED`, поднятый до записи, отвергается снимком, и busy_timeout
// такой конфликт не пережидает — поэтому пауза здесь, а не в PRAGMA.
for (let attempt = 0; attempt < 100; attempt++) {
  try {
    createNote({
      workspace_id: workspaceId,
      agent_id: agentId,
      text: `concurrent successor ${label}`,
      type: "memory",
      supersedes_id: predecessorId,
      expected_superseded_updated_at_ms: expectedVersion,
    });
    outcome = "PASS";
    break;
  } catch (error) {
    if (busy(error)) {
      lastError = String((error as Error)?.message ?? error);
      Bun.sleepSync(20);
      continue;
    }
    outcome = String((error as { code?: string }).code ?? "ERROR");
    break;
  }
}
if (outcome === "UNKNOWN" && lastError) outcome = `BUSY_EXHAUSTED: ${lastError}`;

process.stdout.write(`${JSON.stringify({ label, outcome })}\n`);
