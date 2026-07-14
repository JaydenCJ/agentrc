import fs from "node:fs";
import path from "node:path";
import { isPlainObject } from "../core/merge.js";
import type { Manifest, McpServerConfig } from "../types.js";
import type { Adapter, AdapterContext, ImportResult } from "./types.js";
import { headersOf, requireProjectDir, serversForClient, skillsForClient, stdioEntry } from "./util.js";

function configPath(ctx: AdapterContext): string {
  return ctx.scope === "project"
    ? path.join(requireProjectDir(ctx), ".gemini", "settings.json")
    : path.join(ctx.home, ".gemini", "settings.json");
}

/** Gemini CLI quirk: HTTP servers use `httpUrl`, SSE servers use `url`. */
function toGeminiServer(server: McpServerConfig): Record<string, unknown> {
  if (server.transport === "stdio") return stdioEntry(server);
  if (server.transport === "http") return { httpUrl: server.url, ...headersOf(server) };
  return { url: server.url, ...headersOf(server) };
}

export const geminiAdapter: Adapter = {
  id: "gemini-cli",
  title: "Gemini CLI",
  capabilities: {
    mcpServers: true,
    hooks: false,
    permissions: false,
    skills: false,
    transports: ["stdio", "http", "sse"],
    projectScope: true,
  },

  configPaths(ctx) {
    return [configPath(ctx)];
  },

  detect(ctx) {
    const dir = path.join(ctx.home, ".gemini");
    return fs.existsSync(dir) ? { detected: true, evidence: dir } : { detected: false };
  },

  skillsDir() {
    return undefined;
  },

  plan(manifest, ctx) {
    const warnings: string[] = [];
    const entries: Record<string, unknown> = {};
    for (const [name, server] of serversForClient(manifest, "gemini-cli")) {
      entries[name] = toGeminiServer(server);
    }
    if (manifest.hooks !== undefined && Object.keys(manifest.hooks).length > 0) {
      warnings.push("hooks are not supported by Gemini CLI -- skipped");
    }
    if (manifest.permissions !== undefined) {
      warnings.push("permission rules are not supported by Gemini CLI -- skipped");
    }
    if (skillsForClient(manifest, "gemini-cli").length > 0) {
      warnings.push("skills are not supported by Gemini CLI -- skipped");
    }
    return {
      files: [
        {
          path: configPath(ctx),
          format: "json",
          sets: [{ mode: "merge-record", keyPath: ["mcpServers"], entries }],
        },
      ],
      dirs: [],
      warnings,
    };
  },

  importConfig(ctx): ImportResult {
    const file = configPath(ctx);
    if (!fs.existsSync(file)) return { fragment: {}, sources: [] };
    const data: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    const fragment: ImportResult["fragment"] = {};
    if (isPlainObject(data) && isPlainObject(data.mcpServers)) {
      const servers: NonNullable<Manifest["mcpServers"]> = {};
      for (const [name, raw] of Object.entries(data.mcpServers)) {
        if (!isPlainObject(raw)) continue;
        const server: McpServerConfig = {};
        if (typeof raw.httpUrl === "string") {
          server.transport = "http";
          server.url = raw.httpUrl;
        } else if (typeof raw.url === "string") {
          server.transport = "sse";
          server.url = raw.url;
        } else if (typeof raw.command === "string") {
          server.transport = "stdio";
          server.command = raw.command;
          if (Array.isArray(raw.args)) server.args = raw.args.filter((x): x is string => typeof x === "string");
          if (isPlainObject(raw.env)) {
            const env: Record<string, string> = {};
            for (const [k, v] of Object.entries(raw.env)) if (typeof v === "string") env[k] = v;
            server.env = env;
          }
        } else {
          continue;
        }
        if (server.transport !== "stdio" && isPlainObject(raw.headers)) {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(raw.headers)) if (typeof v === "string") headers[k] = v;
          if (Object.keys(headers).length > 0) server.headers = headers;
        }
        servers[name] = server;
      }
      if (Object.keys(servers).length > 0) fragment.mcpServers = servers;
    }
    return { fragment, sources: [file] };
  },
};
