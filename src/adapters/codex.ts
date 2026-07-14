import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { AgentrcError } from "../core/errors.js";
import { isPlainObject } from "../core/merge.js";
import type { Manifest, McpServerConfig } from "../types.js";
import type { Adapter, AdapterContext, ImportResult } from "./types.js";
import { serversForClient, skillsForClient, stdioEntry } from "./util.js";

function configPath(ctx: AdapterContext): string {
  return path.join(ctx.home, ".codex", "config.toml");
}

export const codexAdapter: Adapter = {
  id: "codex",
  title: "Codex CLI",
  capabilities: {
    mcpServers: true,
    hooks: false,
    permissions: false,
    skills: false,
    transports: ["stdio"],
    projectScope: false,
  },

  configPaths(ctx) {
    return ctx.scope === "project" ? [] : [configPath(ctx)];
  },

  detect(ctx) {
    const dir = path.join(ctx.home, ".codex");
    return fs.existsSync(dir) ? { detected: true, evidence: dir } : { detected: false };
  },

  skillsDir() {
    return undefined;
  },

  plan(manifest, ctx) {
    const warnings: string[] = [];
    const servers = serversForClient(manifest, "codex");

    if (ctx.scope === "project") {
      if (servers.length > 0) {
        warnings.push("Codex has no project-scope configuration; project entries were skipped (sync user scope instead)");
      }
      return { files: [], dirs: [], warnings };
    }

    const entries: Record<string, unknown> = {};
    for (const [name, server] of servers) {
      if (server.transport !== "stdio") {
        warnings.push(`MCP server "${name}" uses ${server.transport} transport, which Codex does not support -- skipped`);
        continue;
      }
      entries[name] = stdioEntry(server);
    }
    if (manifest.hooks !== undefined && Object.keys(manifest.hooks).length > 0) {
      warnings.push("hooks are not supported by Codex -- skipped");
    }
    if (manifest.permissions !== undefined) {
      warnings.push("permission rules are not supported by Codex -- skipped");
    }
    if (skillsForClient(manifest, "codex").length > 0) {
      warnings.push("skills are not supported by Codex -- skipped");
    }

    return {
      files: [
        {
          path: configPath(ctx),
          format: "toml",
          sets: [{ mode: "merge-record", keyPath: ["mcp_servers"], entries }],
        },
      ],
      dirs: [],
      warnings,
    };
  },

  importConfig(ctx): ImportResult {
    const file = configPath({ ...ctx, scope: "user" });
    if (!fs.existsSync(file)) return { fragment: {}, sources: [] };
    let data: unknown;
    try {
      data = parseToml(fs.readFileSync(file, "utf8"));
    } catch (err) {
      throw new AgentrcError(`${file}: invalid TOML: ${(err as Error).message}`);
    }
    const fragment: ImportResult["fragment"] = {};
    if (isPlainObject(data) && isPlainObject(data.mcp_servers)) {
      const servers: NonNullable<Manifest["mcpServers"]> = {};
      for (const [name, raw] of Object.entries(data.mcp_servers)) {
        if (!isPlainObject(raw) || typeof raw.command !== "string") continue;
        const server: McpServerConfig = { transport: "stdio", command: raw.command };
        if (Array.isArray(raw.args)) server.args = raw.args.map((x) => String(x));
        if (isPlainObject(raw.env)) {
          const env: Record<string, string> = {};
          for (const [k, v] of Object.entries(raw.env)) env[k] = String(v);
          server.env = env;
        }
        servers[name] = server;
      }
      if (Object.keys(servers).length > 0) fragment.mcpServers = servers;
    }
    return { fragment, sources: [file] };
  },
};
