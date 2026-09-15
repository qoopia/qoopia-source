#!/usr/bin/env bun
/**
 * Fails when a module boundary regresses.
 *
 * Two things are enforced, both measured on the *runtime* import graph:
 * `import type` is erased by the compiler, so a type-only edge is not a real
 * dependency and is ignored here. Counting it made the codebase look like one
 * 38-file knot when the actual runtime cycle was seven files.
 *
 *  1. Layer direction. utils/ is the bottom of the stack and must not reach
 *     upward; db/ owns schema movement and should not call the domain.
 *  2. Cycle size. Runtime cycles are frozen at what exists today, so new ones
 *     cannot appear and existing ones cannot grow.
 *
 * KNOWN is the set of violations present when this check was introduced. They
 * are listed rather than ignored so each one has to be argued away
 * deliberately. The three migration edges are the interesting ones: an applied
 * migration that calls today's domain code does not reproduce what it did when
 * it was written.
 */
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dir, "../src");
const FORBIDDEN: Record<string, string[]> = {
  utils: ["delivery", "services", "mcp", "db", "auth", "skills", "identity", "bridges", "admin", "api", "ingest", "agent-kit", "migrations", "analytics"],
  db: ["services", "skills", "auth", "delivery", "mcp", "identity", "bridges", "admin", "api"],
};
const KNOWN = new Set([
  "db/migration-033-gate.ts -> services/temporal-migration.ts",
  "db/migration-033-plan.ts -> services/temporal-migration.ts",
  "db/migration-036-backfill.ts -> skills/format.ts",
  "db/migration-036-backfill.ts -> skills/commands.ts",
  "db/migration-041-backfill.ts -> auth/resource-origin.ts",
]);
const KNOWN_CYCLES = [
  ["services/note-relations.ts", "services/note-temporal.ts", "services/notes.ts"],
  ["mcp/compat.ts", "mcp/tools.ts"],
  ["delivery/installed-runtime.ts", "delivery/workspace.ts", "http.ts"],
];

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

export function runtimeSpecifiers(source: string): string[] {
  const result = new Set<string>();
  const tree = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, true);
  const add = (node: ts.Node | undefined) => {
    if (node && ts.isStringLiteralLike(node) && node.text.startsWith(".")) result.add(node.text);
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly = clause?.isTypeOnly || (!clause?.name && bindings && ts.isNamedImports(bindings)
        && bindings.elements.length > 0 && bindings.elements.every(e => e.isTypeOnly));
      if (!typeOnly) add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      const clause = node.exportClause;
      const typeOnly = node.isTypeOnly || (clause && ts.isNamedExports(clause)
        && clause.elements.length > 0 && clause.elements.every(e => e.isTypeOnly));
      if (!typeOnly) add(node.moduleSpecifier);
    } else if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      add(node.arguments[0]);
    } else if (ts.isImportEqualsDeclaration(node) && !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return [...result];
}

export function checkBoundaries(root = ROOT) {
const files = walk(root);
const edges = new Map<string, Set<string>>();
for (const file of files) {
  const targets = new Set<string>();
  for (const specifier of runtimeSpecifiers(fs.readFileSync(file, "utf8"))) {
    const base = path.resolve(path.dirname(file), specifier);
    const candidates = [base, base.replace(/\.js$/, ".ts"), `${base}.ts`, path.join(base, "index.ts")];
    const target = candidates.find(p => fs.existsSync(p) && fs.statSync(p).isFile());
    if (!target) throw new Error(`Unresolved local runtime import: ${file} -> ${specifier}`);
    // This guard covers src; repository tooling is checked by its own tests.
    if (files.includes(target)) targets.add(target);
  }
  edges.set(file, targets);
}

const rel = (f: string) => path.relative(root, f);
const layer = (f: string) => rel(f).split("/")[0]!;
const problems: string[] = [];

for (const [file, targets] of edges) {
  const from = layer(file);
  for (const target of targets) {
    const to = layer(target);
    if (from === to || !FORBIDDEN[from]?.includes(to)) continue;
    const edge = `${rel(file)} -> ${rel(target)}`;
    if (!KNOWN.has(edge)) problems.push(`layer: ${edge}`);
  }
}

// Tarjan, iterative: the graph is small but recursion depth is not worth risking.
const index = new Map<string, number>(), low = new Map<string, number>();
const onStack = new Set<string>(), stack: string[] = [];
let counter = 0;
const components: string[][] = [];
for (const root of files) {
  if (index.has(root)) continue;
  const work: Array<[string, IterableIterator<string>]> = [[root, (edges.get(root) ?? new Set()).values()]];
  index.set(root, counter); low.set(root, counter++); stack.push(root); onStack.add(root);
  while (work.length) {
    const [node, iter] = work[work.length - 1]!;
    let descended = false;
    for (const next of iter) {
      if (!index.has(next)) {
        index.set(next, counter); low.set(next, counter++); stack.push(next); onStack.add(next);
        work.push([next, (edges.get(next) ?? new Set()).values()]);
        descended = true; break;
      }
      if (onStack.has(next)) low.set(node, Math.min(low.get(node)!, index.get(next)!));
    }
    if (descended) continue;
    work.pop();
    const parent = work[work.length - 1]?.[0];
    if (parent) low.set(parent, Math.min(low.get(parent)!, low.get(node)!));
    if (low.get(node) === index.get(node)) {
      const component: string[] = [];
      for (;;) { const w = stack.pop()!; onStack.delete(w); component.push(w); if (w === node) break; }
      if (component.length > 1) components.push(component.map(rel).sort());
    }
  }
}
for (const component of components) {
  if (!KNOWN_CYCLES.some(known => component.every(file => known.includes(file)))) {
    problems.push(`new or enlarged runtime cycle: ${component.join(", ")}`);
  }
}

return { problems, components, files: files.length };
}

if (import.meta.main) {
  const { problems, components, files } = checkBoundaries();
  if (problems.length) {
    console.error(`module boundary check failed:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  const largest = components.reduce((m, c) => Math.max(m, c.length), 0);
  console.log(`module boundaries ok: ${files} files, ${components.length} runtime cycles, largest ${largest}, ${KNOWN.size} known exceptions`);
}
