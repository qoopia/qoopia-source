import { ulid } from "ulid";
import { db } from "../db/connection.ts";
import { QoopiaError } from "../utils/errors.ts";

export function createWorkspace(opts: { name: string; slug?: string }): {
  id: string;
  name: string;
  slug: string;
} {
  const slug =
    opts.slug ||
    opts.name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  // M9 fix: reject empty slugs (e.g. name was punctuation-only)
  if (!slug || !/[a-z0-9]/.test(slug)) {
    throw new QoopiaError(
      "INVALID_INPUT",
      "Derived slug is empty or has no alphanumeric characters. Provide an explicit --slug or use a name with letters/digits.",
    );
  }
  const existing = db
    .prepare(`SELECT id FROM workspaces WHERE slug = ?`)
    .get(slug);
  if (existing) throw new QoopiaError("CONFLICT", `workspace slug '${slug}' exists`);
  const id = ulid();
  db.prepare(`INSERT INTO workspaces (id, name, slug) VALUES (?, ?, ?)`).run(
    id,
    opts.name,
    slug,
  );
  return { id, name: opts.name, slug };
}

/** Ops scripts name their workspace by slug (QOOPIA_WORKSPACE_SLUG, default "default"), never by a hard-coded ID. */
export function workspaceIdBySlug(slug?: string): string {
  const name = slug ?? (process.env.QOOPIA_WORKSPACE_SLUG || "default");
  const row = db.prepare(`SELECT id FROM workspaces WHERE slug = ?`).get(name) as { id: string } | null;
  if (!row) throw new QoopiaError("NOT_FOUND", slug === undefined ? `workspace slug '${name}' not found; set QOOPIA_WORKSPACE_SLUG` : `workspace '${name}' not found`);
  return row.id;
}

export function listWorkspaces() {
  return db
    .prepare(
      `SELECT id, name, slug, created_at FROM workspaces ORDER BY created_at ASC`,
    )
    .all();
}
