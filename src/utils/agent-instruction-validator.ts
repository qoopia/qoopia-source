import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

interface FleetToolsContract {
  schema_version: 1;
  tool_release: string;
  version_marker: string;
  required_workspace_paths: string[];
  tree_excludes: string[];
}

interface InstructionValidationResult {
  ok: boolean;
  checkedFiles: string[];
  checkedReferences: string[];
  errors: string[];
}

interface InstructionReference {
  shown: string;
  target: string;
  /** Markdown links and Claude Code @imports resolve from the file that contains them. */
  fromFile: boolean;
}

function instructionReferences(markdown: string): InstructionReference[] {
  const found = new Map<string, InstructionReference>();
  const add = (shown: string, raw: string, fromFile: boolean, needsSlash: boolean) => {
    const target = raw.trim().replace(/^<|>$/g, "").replace(/#.*$/, "").replace(/:\d+$/, "");
    if (
      !target.endsWith(".md") ||
      (needsSlash && !target.includes("/")) ||
      /[\s$*<>]/.test(target) ||
      target.startsWith("~") ||
      /^[a-z]+:\/\//i.test(target)
    ) return;
    found.set(`${fromFile}:${shown}`, { shown, target, fromFile });
  };
  // Backticked paths name workspace files (the fleet tools convention).
  for (const match of markdown.matchAll(/`([^`\n]+)`/g)) add(match[1]!, match[1]!, false, true);
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) add(match[1]!, match[1]!, true, false);
  for (const match of markdown.matchAll(/^@(\S+)$/gm)) add(match[0]!, match[1]!, true, false);
  // The managed Qoopia block names its documents as JSON strings; absolute, so --check-absolute.
  for (const match of markdown.matchAll(/"(\/[^"\n]+)"/g)) add(match[1]!, match[1]!, true, false);
  return [...found.values()];
}

export function validateAgentInstructionPaths(options: {
  workspaceRoot: string;
  instructionFiles?: string[];
  checkAbsolute?: boolean;
}): InstructionValidationResult {
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const instructionFiles = options.instructionFiles?.length
    ? options.instructionFiles
    : ["AGENTS.md"];
  const checkedFiles: string[] = [];
  const checkedReferences: string[] = [];
  const errors: string[] = [];

  for (const configuredFile of instructionFiles) {
    const instructionPath = path.isAbsolute(configuredFile)
      ? configuredFile
      : path.join(workspaceRoot, configuredFile);
    checkedFiles.push(instructionPath);
    if (!fs.existsSync(instructionPath)) {
      errors.push(`missing instruction file: ${instructionPath}`);
      continue;
    }
    const markdown = fs.readFileSync(instructionPath, "utf8");
    for (const reference of instructionReferences(markdown)) {
      if (path.isAbsolute(reference.target) && !options.checkAbsolute) continue;
      const resolved = path.isAbsolute(reference.target)
        ? path.normalize(reference.target)
        : path.resolve(reference.fromFile ? path.dirname(instructionPath) : workspaceRoot, reference.target);
      checkedReferences.push(resolved);
      if (!fs.existsSync(resolved)) {
        errors.push(
          `unresolved instruction path in ${instructionPath}: ${reference.shown}`,
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    checkedFiles,
    checkedReferences: [...new Set(checkedReferences)].sort(),
    errors,
  };
}

export function readFleetToolsContract(filename: string): FleetToolsContract {
  const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as Partial<FleetToolsContract>;
  if (
    parsed.schema_version !== 1 ||
    !parsed.tool_release ||
    !parsed.version_marker ||
    !Array.isArray(parsed.required_workspace_paths) ||
    !Array.isArray(parsed.tree_excludes)
  ) {
    throw new Error(`invalid fleet tools contract: ${filename}`);
  }
  return parsed as FleetToolsContract;
}

function excluded(relativePath: string, excludes: string[]): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  return excludes.some((entry) => {
    if (entry.endsWith("/")) {
      const prefix = entry.slice(0, -1);
      return normalized === prefix || normalized.startsWith(`${prefix}/`);
    }
    if (entry.startsWith(".")) return normalized.endsWith(entry);
    return normalized === entry;
  });
}

function listTree(root: string, excludes: string[]): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute);
      if (excluded(relative, excludes)) continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(relative);
    }
  };
  visit(root);
  return files.sort();
}

export function digestToolTree(root: string, excludes: string[]): string {
  const absoluteRoot = path.resolve(root);
  if (!fs.statSync(absoluteRoot).isDirectory()) {
    throw new Error(`tool root is not a directory: ${absoluteRoot}`);
  }
  const hash = createHash("sha256");
  for (const relative of listTree(absoluteRoot, excludes)) {
    const absolute = path.join(absoluteRoot, relative);
    const stat = fs.lstatSync(absolute);
    hash.update(relative.split(path.sep).join("/"));
    hash.update("\0");
    hash.update(stat.isSymbolicLink() ? fs.readlinkSync(absolute) : fs.readFileSync(absolute));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function validateFleetToolLayout(options: {
  workspaceRoot: string;
  canonicalToolsRoot: string;
  contract: FleetToolsContract;
}): string[] {
  const errors: string[] = [];
  const workspaceRoot = path.resolve(options.workspaceRoot);
  const workspaceToolsRoot = path.join(workspaceRoot, "tools");
  const canonicalToolsRoot = path.resolve(options.canonicalToolsRoot);

  for (const requiredPath of options.contract.required_workspace_paths) {
    if (!fs.existsSync(path.join(workspaceRoot, requiredPath))) {
      errors.push(`missing required fleet tool path: ${requiredPath}`);
    }
  }

  for (const toolRoot of new Set([canonicalToolsRoot, workspaceToolsRoot])) {
    const marker = path.join(toolRoot, options.contract.version_marker);
    if (!fs.existsSync(marker)) {
      errors.push(`missing fleet tool version marker: ${marker}`);
    } else if (fs.readFileSync(marker, "utf8").trim() !== options.contract.tool_release) {
      errors.push(
        `fleet tool version mismatch at ${marker}; expected ${options.contract.tool_release}`,
      );
    }
  }

  if (errors.length === 0) {
    const canonicalDigest = digestToolTree(
      canonicalToolsRoot,
      options.contract.tree_excludes,
    );
    const workspaceDigest = digestToolTree(
      workspaceToolsRoot,
      options.contract.tree_excludes,
    );
    if (canonicalDigest !== workspaceDigest) {
      errors.push(
        `fleet tool tree differs from canonical bundle: ${workspaceToolsRoot}`,
      );
    }
  }
  return errors;
}
