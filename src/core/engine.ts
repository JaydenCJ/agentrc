import fs from "node:fs";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { ADAPTERS, selectClients } from "../adapters/index.js";
import type { AdapterContext, DirPlan, FilePlan } from "../adapters/types.js";
import type { ClientId, Manifest } from "../types.js";
import { unifiedDiff } from "./difflib.js";
import { AgentrcError } from "./errors.js";
import { backupFile, dirsEqual, copyDirReplace, readTextIfExists, rmrf, writeFileAtomic } from "./fsio.js";
import { loadEffectiveManifest } from "./manifest.js";
import { clone, isPlainObject } from "./merge.js";
import { createSecretMasker, findSecretRefs, resolveDeep, type SecretResolver, defaultResolver } from "./secrets.js";
import { emptyFileState, loadState, saveState, type AgentrcState, type FileState } from "./state.js";

export interface EngineOptions {
  home: string;
  configPath: string;
  projectDir?: string;
  clients?: ClientId[];
  /** Actually write files (sync) vs. plan only (status/diff/--dry-run). */
  write: boolean;
  /** Compute unified diffs for changed files. */
  wantDiff?: boolean;
  /** Emit `${NAME}` env-style references instead of resolved secret values. */
  refs?: boolean;
  /** Back up files as `<file>.agentrc.bak` before the first overwrite. */
  backup?: boolean;
  resolver?: SecretResolver;
}

export type FileActionKind = "create" | "update" | "unchanged" | "skip";

export interface FileAction {
  client: ClientId;
  path: string;
  action: FileActionKind;
  /** Semantic change list, e.g. "+ mcpServers.github". */
  changes: string[];
  diff?: string;
  backupPath?: string;
}

export type DirActionKind = "create" | "update" | "unchanged" | "remove";

export interface DirAction {
  client: ClientId;
  name: string;
  source: string;
  target: string;
  action: DirActionKind;
}

export interface SyncReport {
  scope: "user" | "project";
  /** Home directory the run targeted; used to display paths as `~/...`. */
  home: string;
  clients: ClientId[];
  manifestSources: string[];
  files: FileAction[];
  dirs: DirAction[];
  warnings: Array<{ client: ClientId; message: string }>;
  /** Client-independent advisories, e.g. env vars shadowing stored secrets. */
  notices: string[];
  secretsResolved: number;
  changed: boolean;
}

// ---------------------------------------------------------------------------
// Document helpers
// ---------------------------------------------------------------------------

function getAt(doc: Record<string, unknown>, keyPath: string[]): unknown {
  let cursor: unknown = doc;
  for (const key of keyPath) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

function setAt(doc: Record<string, unknown>, keyPath: string[], value: unknown): void {
  let cursor: Record<string, unknown> = doc;
  for (const key of keyPath.slice(0, -1)) {
    const next = cursor[key];
    if (!isPlainObject(next)) {
      const fresh: Record<string, unknown> = {};
      cursor[key] = fresh;
      cursor = fresh;
    } else {
      cursor = next;
    }
  }
  cursor[keyPath[keyPath.length - 1]!] = value;
}

function deleteAt(doc: Record<string, unknown>, keyPath: string[]): void {
  let cursor: unknown = doc;
  for (const key of keyPath.slice(0, -1)) {
    if (!isPlainObject(cursor)) return;
    cursor = cursor[key];
  }
  if (isPlainObject(cursor)) delete cursor[keyPath[keyPath.length - 1]!];
}

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Display form of an absolute path: the home prefix becomes `~`. Used only
 *  for human-facing output; reports and state keep real paths. */
export function displayPath(p: string, home: string): string {
  if (p === home) return "~";
  return p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

// ---------------------------------------------------------------------------
// Applying a file plan
// ---------------------------------------------------------------------------

export interface ApplyResult {
  doc: Record<string, unknown>;
  changes: string[];
  nextState: FileState;
}

/** Pure document transformation: apply the plan's set operations to the
 *  existing document, honoring previous state for stale-entry cleanup. */
export function applyOps(
  existingDoc: Record<string, unknown>,
  plan: FilePlan,
  prev: FileState,
): ApplyResult {
  const doc = clone(existingDoc);
  const changes: string[] = [];
  const nextState = emptyFileState();

  for (const op of plan.sets) {
    const joined = op.keyPath.join(".");
    if (op.mode === "merge-record") {
      const existingRaw = getAt(doc, op.keyPath);
      if (existingRaw !== undefined && !isPlainObject(existingRaw)) {
        throw new AgentrcError(`${plan.path}: expected a mapping at "${joined}", found ${typeof existingRaw}`);
      }
      const record: Record<string, unknown> = isPlainObject(existingRaw) ? existingRaw : {};
      // Remove entries we managed before that are gone from the manifest.
      for (const name of prev.records[joined] ?? []) {
        if (!(name in op.entries) && name in record) {
          delete record[name];
          changes.push(`- ${joined}.${name}`);
        }
      }
      for (const [name, value] of Object.entries(op.entries)) {
        if (!(name in record)) changes.push(`+ ${joined}.${name}`);
        else if (!jsonEqual(record[name], value)) changes.push(`~ ${joined}.${name}`);
        record[name] = value;
      }
      // Do not materialize an empty record in a file that never had one.
      if (existingRaw === undefined && Object.keys(record).length === 0) {
        // nothing to write
      } else {
        setAt(doc, op.keyPath, record);
      }
      nextState.records[joined] = Object.keys(op.entries).sort();
    } else {
      const existingValue = getAt(doc, op.keyPath);
      if (existingValue === undefined) changes.push(`+ ${joined}`);
      else if (!jsonEqual(existingValue, op.value)) changes.push(`~ ${joined}`);
      setAt(doc, op.keyPath, op.value);
      nextState.keys.push(joined);
    }
  }

  // Keys we owned before (e.g. "hooks") that no current set touches.
  for (const key of prev.keys) {
    if (nextState.keys.includes(key)) continue;
    const keyPath = key.split(".");
    if (getAt(doc, keyPath) !== undefined) {
      deleteAt(doc, keyPath);
      changes.push(`- ${key}`);
    }
  }
  // Records we owned before that no current set touches.
  for (const [joined, names] of Object.entries(prev.records)) {
    if (nextState.records[joined] !== undefined) continue;
    const record = getAt(doc, joined.split("."));
    if (!isPlainObject(record)) continue;
    for (const name of names) {
      if (name in record) {
        delete record[name];
        changes.push(`- ${joined}.${name}`);
      }
    }
  }

  return { doc, changes, nextState };
}

function parseExisting(plan: FilePlan, text: string): Record<string, unknown> {
  if (text.trim() === "") return {};
  let data: unknown;
  try {
    data = plan.format === "json" ? JSON.parse(text) : parseToml(text);
  } catch (err) {
    throw new AgentrcError(
      `${plan.path}: cannot parse existing ${plan.format.toUpperCase()} (${(err as Error).message}); fix or remove the file, then retry`,
    );
  }
  if (!isPlainObject(data)) {
    throw new AgentrcError(`${plan.path}: expected the file to contain a top-level object`);
  }
  return data;
}

function serialize(plan: FilePlan, doc: Record<string, unknown>): string {
  if (plan.format === "json") return `${JSON.stringify(doc, null, 2)}\n`;
  const toml = stringifyToml(doc);
  return toml.endsWith("\n") ? toml : `${toml}\n`;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export function runEngine(options: EngineOptions): SyncReport {
  const loaded = loadEffectiveManifest(options.configPath, options.projectDir);
  return runEngineWithManifest(loaded.manifest, loaded.sources, options);
}

export function runEngineWithManifest(
  manifest: Manifest,
  manifestSources: string[],
  options: EngineOptions,
): SyncReport {
  const scope: "user" | "project" = options.projectDir !== undefined ? "project" : "user";
  const clients = selectClients(manifest, options.clients);
  const ctx: AdapterContext = {
    home: options.home,
    scope,
    ...(options.projectDir !== undefined ? { projectDir: options.projectDir } : {}),
  };

  // Secrets: resolve every reference up front so a missing secret fails the
  // whole run before any file is touched.
  const secretRefs = findSecretRefs(manifest);
  let resolved: Manifest = manifest;
  let secretsResolved = 0;
  // Redacts resolved secret values from diff text; identity until secrets
  // are actually resolved (refs mode and secret-free manifests leak nothing).
  let maskSecrets: (text: string) => string = (text) => text;
  const notices: string[] = [];
  if (secretRefs.size > 0) {
    if (options.refs === true) {
      resolved = resolveDeep(manifest, (name) => `\${${name}}`);
    } else {
      const resolver = options.resolver ?? defaultResolver(options.home);
      const { values, missing, shadowed } = resolver.resolveAll(secretRefs);
      if (missing.length > 0) {
        throw new AgentrcError(
          `missing secrets: ${missing.join(", ")}\n` +
            missing.map((name) => `  agentrc secret set ${name}`).join("\n") +
            `\n(or export them as environment variables, or pass --refs)`,
        );
      }
      for (const s of shadowed) {
        notices.push(
          `secret "${s.name}" resolved from the environment, shadowing the value stored in the ${s.over} store (unset $${s.name} to use the stored value)`,
        );
      }
      resolved = resolveDeep(manifest, (name) => values.get(name)!);
      secretsResolved = values.size;
      maskSecrets = createSecretMasker(values);
    }
  }

  const state = loadState(options.home);
  const report: SyncReport = {
    scope,
    home: options.home,
    clients,
    manifestSources,
    files: [],
    dirs: [],
    warnings: [],
    notices,
    secretsResolved,
    changed: false,
  };

  const plannedDirTargets = new Set<string>();
  const skillBases: Array<{ client: ClientId; base: string }> = [];

  // Planning pass: adapters are pure, so compute every plan up front and
  // validate all skill sources before the first byte is written. A missing
  // skill directory must fail the whole run, never leave a partial sync.
  const planned: Array<{ client: ClientId; files: FilePlan[]; dirs: DirPlan[] }> = [];
  for (const client of clients) {
    const adapter = ADAPTERS[client];
    const { files, dirs, warnings } = adapter.plan(resolved, ctx);
    for (const message of warnings) report.warnings.push({ client, message });
    planned.push({ client, files, dirs });
    const base = adapter.skillsDir(ctx);
    if (base !== undefined) skillBases.push({ client, base });
  }
  for (const { dirs } of planned) {
    for (const dirPlan of dirs) assertDirSource(dirPlan);
  }

  // Apply pass: everything below may touch the filesystem (when write=true).
  for (const { client, files, dirs } of planned) {
    for (const plan of files) {
      report.files.push(processFilePlan(client, plan, state, options, maskSecrets));
    }
    for (const dirPlan of dirs) {
      plannedDirTargets.add(dirPlan.target);
      report.dirs.push(processDirPlan(client, dirPlan, state, options));
    }
  }

  // Skills that were removed from the manifest: their target dirs are in
  // state but not in any current plan. Only clean up under the skill bases of
  // clients selected in this run, so `--client cursor` never deletes Claude's
  // skills.
  for (const target of [...state.dirs]) {
    if (plannedDirTargets.has(target)) continue;
    const owner = skillBases.find(({ base }) => target.startsWith(base + path.sep));
    if (owner === undefined) continue;
    report.dirs.push({
      client: owner.client,
      name: path.basename(target),
      source: "",
      target,
      action: "remove",
    });
    if (options.write) {
      rmrf(target);
      state.dirs = state.dirs.filter((d) => d !== target);
    }
  }

  report.changed =
    report.files.some((f) => f.action === "create" || f.action === "update") ||
    report.dirs.some((d) => d.action !== "unchanged");

  if (options.write) saveState(options.home, state);
  return report;
}

function processFilePlan(
  client: ClientId,
  plan: FilePlan,
  state: AgentrcState,
  options: EngineOptions,
  maskSecrets: (text: string) => string,
): FileAction {
  const existingText = readTextIfExists(plan.path);
  const existingDoc = existingText === undefined ? {} : parseExisting(plan, existingText);
  const prev = state.files[plan.path] ?? emptyFileState();
  const { doc, changes, nextState } = applyOps(existingDoc, plan, prev);

  let action: FileActionKind;
  if (jsonEqual(existingDoc, doc)) {
    action = existingText === undefined ? "skip" : "unchanged";
  } else {
    action = existingText === undefined ? "create" : "update";
  }

  const result: FileAction = { client, path: plan.path, action, changes };

  if (action === "create" || action === "update") {
    const newText = serialize(plan, doc);
    if (options.wantDiff === true) {
      const label = displayPath(plan.path, options.home);
      // Diff text is human-facing (and embedded in the JSON report), so
      // resolved secret values are redacted back to their references.
      result.diff = maskSecrets(
        unifiedDiff(existingText ?? "", newText, {
          oldLabel: `${label} (current)`,
          newLabel: `${label} (after sync)`,
        }),
      );
    }
    if (options.write) {
      if (action === "update" && options.backup !== false) {
        const backupPath = backupFile(plan.path);
        if (backupPath !== undefined) result.backupPath = backupPath;
      }
      writeFileAtomic(plan.path, newText);
      state.files[plan.path] = nextState;
    }
  } else if (options.write) {
    // Keep state accurate even when nothing changed on disk.
    if (action === "unchanged") state.files[plan.path] = nextState;
    else delete state.files[plan.path];
  }

  return result;
}

/** Called during the planning pass, before any write. */
function assertDirSource(plan: DirPlan): void {
  if (!fs.existsSync(plan.source) || !fs.statSync(plan.source).isDirectory()) {
    throw new AgentrcError(`skill "${plan.name}": source directory not found: ${plan.source}`);
  }
}

function processDirPlan(
  client: ClientId,
  plan: DirPlan,
  state: AgentrcState,
  options: EngineOptions,
): DirAction {
  const exists = fs.existsSync(plan.target);
  let action: DirActionKind;
  if (exists && dirsEqual(plan.source, plan.target)) action = "unchanged";
  else action = exists ? "update" : "create";

  if (options.write) {
    if (action !== "unchanged") copyDirReplace(plan.source, plan.target);
    if (!state.dirs.includes(plan.target)) state.dirs.push(plan.target);
  }
  return { client, name: plan.name, source: plan.source, target: plan.target, action };
}
