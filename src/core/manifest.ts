import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import {
  CLIENT_IDS,
  HOOK_EVENTS,
  TRANSPORTS,
  isClientId,
  type HookEvent,
  type Manifest,
  type McpServerConfig,
} from "../types.js";
import { AgentrcError } from "./errors.js";
import { deepMerge, isPlainObject, stripNulls } from "./merge.js";

const TOP_LEVEL_KEYS = new Set(["version", "extends", "clients", "mcpServers", "skills", "hooks", "permissions"]);
const SERVER_KEYS = new Set(["transport", "command", "args", "env", "url", "headers", "clients"]);
const SKILL_KEYS = new Set(["path", "clients"]);
const HOOK_KEYS = new Set(["matcher", "command", "timeout"]);
const PERMISSION_KEYS = new Set(["allow", "deny", "ask", "defaultMode"]);

export interface LoadedManifest {
  manifest: Manifest;
  /** Every file that contributed, in merge order. */
  sources: string[];
  /** Directory of the root config file. */
  configDir: string;
}

function fail(source: string, message: string): never {
  throw new AgentrcError(`${source}: ${message}`);
}

function expectStringArray(source: string, label: string, value: unknown): void {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    fail(source, `${label} must be an array of strings`);
  }
}

function expectStringRecord(source: string, label: string, value: unknown): void {
  if (!isPlainObject(value)) fail(source, `${label} must be a map of string values`);
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== "string") fail(source, `${label}.${k} must be a string`);
  }
}

/** Structural validation of a single manifest file. Completeness (e.g. every
 *  server having a command or url) is checked after merging, because overlays
 *  are allowed to be partial. */
export function validateFragment(data: unknown, source: string): void {
  if (!isPlainObject(data)) fail(source, "manifest must be a YAML mapping");
  for (const key of Object.keys(data)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      fail(source, `unknown top-level key "${key}" (expected one of: ${[...TOP_LEVEL_KEYS].join(", ")})`);
    }
  }
  if (data.version !== undefined && typeof data.version !== "number") {
    fail(source, `"version" must be a number`);
  }
  if (data.extends !== undefined) expectStringArray(source, `"extends"`, data.extends);
  if (data.clients !== undefined) {
    if (!Array.isArray(data.clients)) fail(source, `"clients" must be an array`);
    for (const c of data.clients) {
      if (!isClientId(c)) {
        fail(source, `unknown client "${String(c)}" (expected one of: ${CLIENT_IDS.join(", ")})`);
      }
    }
  }
  if (data.mcpServers !== undefined) {
    if (!isPlainObject(data.mcpServers)) fail(source, `"mcpServers" must be a map of server definitions`);
    for (const [name, server] of Object.entries(data.mcpServers)) {
      if (server === null) continue; // deletion marker in overlays
      if (!isPlainObject(server)) fail(source, `mcpServers.${name} must be a mapping (or null to remove it)`);
      for (const key of Object.keys(server)) {
        if (!SERVER_KEYS.has(key)) fail(source, `mcpServers.${name}: unknown key "${key}"`);
      }
      if (server.transport !== undefined && !(TRANSPORTS as readonly unknown[]).includes(server.transport)) {
        fail(source, `mcpServers.${name}: transport must be one of ${TRANSPORTS.join(", ")}`);
      }
      if (server.command !== undefined && typeof server.command !== "string") {
        fail(source, `mcpServers.${name}: "command" must be a string`);
      }
      if (server.url !== undefined && typeof server.url !== "string") {
        fail(source, `mcpServers.${name}: "url" must be a string`);
      }
      if (server.args !== undefined) expectStringArray(source, `mcpServers.${name}.args`, server.args);
      if (server.env !== undefined) expectStringRecord(source, `mcpServers.${name}.env`, server.env);
      if (server.headers !== undefined) expectStringRecord(source, `mcpServers.${name}.headers`, server.headers);
      if (server.clients !== undefined) {
        if (!Array.isArray(server.clients) || server.clients.some((c) => !isClientId(c))) {
          fail(source, `mcpServers.${name}.clients must be an array of: ${CLIENT_IDS.join(", ")}`);
        }
      }
    }
  }
  if (data.skills !== undefined) {
    if (!isPlainObject(data.skills)) fail(source, `"skills" must be a map of skill definitions`);
    for (const [name, skill] of Object.entries(data.skills)) {
      if (skill === null) continue;
      if (!isPlainObject(skill)) fail(source, `skills.${name} must be a mapping (or null to remove it)`);
      for (const key of Object.keys(skill)) {
        if (!SKILL_KEYS.has(key)) fail(source, `skills.${name}: unknown key "${key}"`);
      }
      if (typeof skill.path !== "string" || skill.path === "") {
        fail(source, `skills.${name}: "path" must be a non-empty string`);
      }
      if (skill.clients !== undefined) {
        if (!Array.isArray(skill.clients) || skill.clients.some((c) => !isClientId(c))) {
          fail(source, `skills.${name}.clients must be an array of: ${CLIENT_IDS.join(", ")}`);
        }
      }
    }
  }
  if (data.hooks !== undefined) {
    if (!isPlainObject(data.hooks)) fail(source, `"hooks" must be a map of hook events`);
    for (const [event, entries] of Object.entries(data.hooks)) {
      if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
        fail(source, `hooks: unknown event "${event}" (expected one of: ${HOOK_EVENTS.join(", ")})`);
      }
      if (entries === null) continue;
      if (!Array.isArray(entries)) fail(source, `hooks.${event} must be an array`);
      for (const entry of entries) {
        if (!isPlainObject(entry)) fail(source, `hooks.${event}: entries must be mappings`);
        for (const key of Object.keys(entry)) {
          if (!HOOK_KEYS.has(key)) fail(source, `hooks.${event}: unknown key "${key}"`);
        }
        if (typeof entry.command !== "string" || entry.command === "") {
          fail(source, `hooks.${event}: "command" must be a non-empty string`);
        }
        if (entry.matcher !== undefined && typeof entry.matcher !== "string") {
          fail(source, `hooks.${event}: "matcher" must be a string`);
        }
        if (entry.timeout !== undefined && typeof entry.timeout !== "number") {
          fail(source, `hooks.${event}: "timeout" must be a number`);
        }
      }
    }
  }
  if (data.permissions !== undefined && data.permissions !== null) {
    if (!isPlainObject(data.permissions)) fail(source, `"permissions" must be a mapping`);
    for (const key of Object.keys(data.permissions)) {
      if (!PERMISSION_KEYS.has(key)) fail(source, `permissions: unknown key "${key}"`);
    }
    for (const key of ["allow", "deny", "ask"] as const) {
      const value = data.permissions[key];
      if (value !== undefined && value !== null) expectStringArray(source, `permissions.${key}`, value);
    }
    if (data.permissions.defaultMode !== undefined && typeof data.permissions.defaultMode !== "string") {
      fail(source, `permissions.defaultMode must be a string`);
    }
  }
}

function parseYamlFile(file: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new AgentrcError(`config file not found: ${file}`);
  }
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    throw new AgentrcError(`${file}: invalid YAML: ${(err as Error).message}`);
  }
  if (data === null || data === undefined) return {};
  if (!isPlainObject(data)) throw new AgentrcError(`${file}: manifest must be a YAML mapping`);
  return data;
}

/** Rewrite relative skill paths against the directory of the file that
 *  declared them, so presets shipped in a team repo keep working. */
function absolutizeSkillPaths(data: Record<string, unknown>, baseDir: string): void {
  if (!isPlainObject(data.skills)) return;
  for (const skill of Object.values(data.skills)) {
    if (!isPlainObject(skill) || typeof skill.path !== "string") continue;
    if (!path.isAbsolute(skill.path)) {
      skill.path = path.resolve(baseDir, skill.path);
    }
  }
}

/** Hook commands that are explicitly relative paths ("./x" or "../x") are
 *  resolved against the directory of the declaring file, matching the skill
 *  path behavior — otherwise clients would resolve them against their session
 *  cwd and the hook would never fire. Bare commands ("npm test"), absolute
 *  paths and shell pipelines are passed through untouched. Only the leading
 *  path token is rewritten, so "./guard.sh --strict" keeps its arguments. */
function absolutizeHookCommands(data: Record<string, unknown>, baseDir: string): void {
  if (!isPlainObject(data.hooks)) return;
  for (const entries of Object.values(data.hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isPlainObject(entry) || typeof entry.command !== "string") continue;
      if (!entry.command.startsWith("./") && !entry.command.startsWith("../")) continue;
      const spaceIndex = entry.command.search(/\s/);
      const head = spaceIndex === -1 ? entry.command : entry.command.slice(0, spaceIndex);
      const rest = spaceIndex === -1 ? "" : entry.command.slice(spaceIndex);
      entry.command = path.resolve(baseDir, head) + rest;
    }
  }
}

function loadChain(file: string, activeStack: Set<string>, sources: string[]): unknown {
  const abs = path.resolve(file);
  const key = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
  if (activeStack.has(key)) {
    throw new AgentrcError(`circular "extends" detected at ${abs}`);
  }
  activeStack.add(key);
  const data = parseYamlFile(abs);
  validateFragment(data, abs);
  absolutizeSkillPaths(data, path.dirname(abs));
  absolutizeHookCommands(data, path.dirname(abs));
  sources.push(abs);

  let merged: unknown = {};
  const extendsList = (data.extends as string[] | undefined) ?? [];
  for (const rel of extendsList) {
    const target = path.isAbsolute(rel) ? rel : path.resolve(path.dirname(abs), rel);
    merged = deepMerge(merged, loadChain(target, activeStack, sources));
  }
  const self = { ...data };
  delete self.extends;
  merged = deepMerge(merged, self);
  activeStack.delete(key); // allow diamond-shaped preset graphs
  return merged;
}

export function findProjectManifest(projectDir: string): string | undefined {
  for (const name of [".agentrc.yaml", ".agentrc.yml", "agentrc.yaml"]) {
    const candidate = path.join(projectDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Post-merge normalization + completeness checks. */
export function finalizeManifest(data: unknown, source: string): Manifest {
  if (!isPlainObject(data)) fail(source, "manifest must be a mapping");
  if (data.version === undefined) {
    fail(source, `missing required "version" field (add: version: 1)`);
  }
  if (data.version !== 1) {
    fail(source, `unsupported manifest version ${String(data.version)}; this release supports version 1`);
  }
  const manifest = data as unknown as Manifest;
  for (const [name, server] of Object.entries(manifest.mcpServers ?? {})) {
    normalizeServer(name, server, source);
  }
  return manifest;
}

function normalizeServer(name: string, server: McpServerConfig, source: string): void {
  if (server.transport === undefined) {
    if (server.command !== undefined) server.transport = "stdio";
    else if (server.url !== undefined) server.transport = "http";
    else fail(source, `mcpServers.${name}: needs "command" (stdio) or "url" (http/sse)`);
  }
  if (server.transport === "stdio") {
    if (server.command === undefined) fail(source, `mcpServers.${name}: transport is stdio but "command" is missing`);
    if (server.url !== undefined) fail(source, `mcpServers.${name}: a stdio server must not set "url"`);
  } else {
    if (server.url === undefined) fail(source, `mcpServers.${name}: transport is ${server.transport} but "url" is missing`);
    if (server.command !== undefined) {
      fail(source, `mcpServers.${name}: a ${server.transport} server must not set "command"`);
    }
  }
}

/** Load config -> presets (extends) -> project overlay, merge, normalize. */
export function loadEffectiveManifest(configPath: string, projectDir?: string): LoadedManifest {
  const sources: string[] = [];
  const absConfig = path.resolve(configPath);
  if (!fs.existsSync(absConfig)) {
    throw new AgentrcError(`config file not found: ${absConfig} (run "agentrc init" to create one)`);
  }
  let merged = loadChain(absConfig, new Set(), sources);
  if (projectDir !== undefined) {
    const projectManifest = findProjectManifest(projectDir);
    if (projectManifest !== undefined) {
      merged = deepMerge(merged, loadChain(projectManifest, new Set(), sources));
    }
  }
  merged = stripNulls(merged);
  const manifest = finalizeManifest(merged, absConfig);
  return { manifest, sources, configDir: path.dirname(absConfig) };
}

export { type HookEvent };
