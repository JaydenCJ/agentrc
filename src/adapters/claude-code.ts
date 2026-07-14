import fs from "node:fs";
import path from "node:path";
import { isPlainObject } from "../core/merge.js";
import { HOOK_EVENTS, type HookEntry, type HookEvent, type HooksConfig, type Manifest, type McpServerConfig, type PermissionsConfig } from "../types.js";
import type { Adapter, AdapterContext, FilePlan, ImportResult, JsonSetOp } from "./types.js";
import { headersOf, requireProjectDir, serversForClient, skillsForClient, stdioEntry } from "./util.js";

/** manifest hook event -> Claude Code settings.json event */
const EVENT_TO_CLAUDE: Record<HookEvent, string> = {
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  userPromptSubmit: "UserPromptSubmit",
  sessionStart: "SessionStart",
  sessionEnd: "SessionEnd",
  stop: "Stop",
  subagentStop: "SubagentStop",
  preCompact: "PreCompact",
  notification: "Notification",
};

const CLAUDE_TO_EVENT: Record<string, HookEvent> = Object.fromEntries(
  Object.entries(EVENT_TO_CLAUDE).map(([k, v]) => [v, k as HookEvent]),
);

function toClaudeServer(server: McpServerConfig): Record<string, unknown> {
  if (server.transport === "stdio") {
    return { type: "stdio", ...stdioEntry(server) };
  }
  return { type: server.transport, url: server.url, ...headersOf(server) };
}

export function toClaudeHooks(hooks: HooksConfig): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const event of HOOK_EVENTS) {
    const entries = hooks[event];
    if (entries === undefined || entries.length === 0) continue;
    out[EVENT_TO_CLAUDE[event]] = entries.map((entry) => ({
      ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}),
      hooks: [
        {
          type: "command",
          command: entry.command,
          ...(entry.timeout !== undefined ? { timeout: entry.timeout } : {}),
        },
      ],
    }));
  }
  return out;
}

function toClaudePermissions(permissions: PermissionsConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (permissions.allow !== undefined) out.allow = permissions.allow;
  if (permissions.deny !== undefined) out.deny = permissions.deny;
  if (permissions.ask !== undefined) out.ask = permissions.ask;
  if (permissions.defaultMode !== undefined) out.defaultMode = permissions.defaultMode;
  return out;
}

function mcpConfigPath(ctx: AdapterContext): string {
  return ctx.scope === "project"
    ? path.join(requireProjectDir(ctx), ".mcp.json")
    : path.join(ctx.home, ".claude.json");
}

function settingsPath(ctx: AdapterContext): string {
  return ctx.scope === "project"
    ? path.join(requireProjectDir(ctx), ".claude", "settings.json")
    : path.join(ctx.home, ".claude", "settings.json");
}

function skillsBase(ctx: AdapterContext): string {
  return ctx.scope === "project"
    ? path.join(requireProjectDir(ctx), ".claude", "skills")
    : path.join(ctx.home, ".claude", "skills");
}

export const claudeCodeAdapter: Adapter = {
  id: "claude-code",
  title: "Claude Code",
  capabilities: {
    mcpServers: true,
    hooks: true,
    permissions: true,
    skills: true,
    transports: ["stdio", "http", "sse"],
    projectScope: true,
  },

  configPaths(ctx) {
    return [mcpConfigPath(ctx), settingsPath(ctx)];
  },

  detect(ctx) {
    for (const candidate of [path.join(ctx.home, ".claude"), path.join(ctx.home, ".claude.json")]) {
      if (fs.existsSync(candidate)) return { detected: true, evidence: candidate };
    }
    return { detected: false };
  },

  skillsDir(ctx) {
    return skillsBase(ctx);
  },

  plan(manifest, ctx) {
    const entries: Record<string, unknown> = {};
    for (const [name, server] of serversForClient(manifest, "claude-code")) {
      entries[name] = toClaudeServer(server);
    }
    const files: FilePlan[] = [
      {
        path: mcpConfigPath(ctx),
        format: "json",
        sets: [{ mode: "merge-record", keyPath: ["mcpServers"], entries }],
      },
    ];

    const settingsSets: JsonSetOp[] = [];
    if (manifest.hooks !== undefined && Object.keys(manifest.hooks).length > 0) {
      settingsSets.push({ mode: "replace-key", keyPath: ["hooks"], value: toClaudeHooks(manifest.hooks) });
    }
    if (manifest.permissions !== undefined) {
      settingsSets.push({
        mode: "replace-key",
        keyPath: ["permissions"],
        value: toClaudePermissions(manifest.permissions),
      });
    }
    files.push({ path: settingsPath(ctx), format: "json", sets: settingsSets });

    const dirs = skillsForClient(manifest, "claude-code").map(([name, skill]) => ({
      name,
      source: skill.path,
      target: path.join(skillsBase(ctx), name),
    }));

    return { files, dirs, warnings: [] };
  },

  importConfig(ctx): ImportResult {
    const sources: string[] = [];
    const fragment: ImportResult["fragment"] = {};

    const mcpFile = mcpConfigPath(ctx);
    if (fs.existsSync(mcpFile)) {
      sources.push(mcpFile);
      const data: unknown = JSON.parse(fs.readFileSync(mcpFile, "utf8"));
      if (isPlainObject(data) && isPlainObject(data.mcpServers)) {
        const servers: NonNullable<Manifest["mcpServers"]> = {};
        for (const [name, raw] of Object.entries(data.mcpServers)) {
          if (!isPlainObject(raw)) continue;
          servers[name] = fromClaudeServer(raw);
        }
        if (Object.keys(servers).length > 0) fragment.mcpServers = servers;
      }
    }

    const settingsFile = settingsPath(ctx);
    if (fs.existsSync(settingsFile)) {
      sources.push(settingsFile);
      const data: unknown = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
      if (isPlainObject(data)) {
        if (isPlainObject(data.hooks)) {
          const hooks = fromClaudeHooks(data.hooks);
          if (Object.keys(hooks).length > 0) fragment.hooks = hooks;
        }
        if (isPlainObject(data.permissions)) {
          const permissions: PermissionsConfig = {};
          const p = data.permissions;
          if (Array.isArray(p.allow)) permissions.allow = p.allow.filter((x): x is string => typeof x === "string");
          if (Array.isArray(p.deny)) permissions.deny = p.deny.filter((x): x is string => typeof x === "string");
          if (Array.isArray(p.ask)) permissions.ask = p.ask.filter((x): x is string => typeof x === "string");
          if (typeof p.defaultMode === "string") permissions.defaultMode = p.defaultMode;
          if (Object.keys(permissions).length > 0) fragment.permissions = permissions;
        }
      }
    }

    return { fragment, sources };
  },
};

function fromClaudeServer(raw: Record<string, unknown>): McpServerConfig {
  const server: McpServerConfig = {};
  const type = typeof raw.type === "string" ? raw.type : undefined;
  if (type === "http" || type === "sse" || (type === undefined && typeof raw.url === "string")) {
    server.transport = type === "sse" ? "sse" : "http";
    if (typeof raw.url === "string") server.url = raw.url;
    if (isPlainObject(raw.headers)) server.headers = stringRecord(raw.headers);
  } else {
    server.transport = "stdio";
    if (typeof raw.command === "string") server.command = raw.command;
    if (Array.isArray(raw.args)) server.args = raw.args.filter((x): x is string => typeof x === "string");
    if (isPlainObject(raw.env)) server.env = stringRecord(raw.env);
  }
  return server;
}

function fromClaudeHooks(raw: Record<string, unknown>): HooksConfig {
  const hooks: HooksConfig = {};
  for (const [claudeEvent, groups] of Object.entries(raw)) {
    const event = CLAUDE_TO_EVENT[claudeEvent];
    if (event === undefined || !Array.isArray(groups)) continue;
    const entries: HookEntry[] = [];
    for (const group of groups) {
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) continue;
      for (const h of group.hooks) {
        if (!isPlainObject(h) || h.type !== "command" || typeof h.command !== "string") continue;
        entries.push({
          ...(typeof group.matcher === "string" ? { matcher: group.matcher } : {}),
          command: h.command,
          ...(typeof h.timeout === "number" ? { timeout: h.timeout } : {}),
        });
      }
    }
    if (entries.length > 0) hooks[event] = entries;
  }
  return hooks;
}

function stringRecord(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  }
  return out;
}
