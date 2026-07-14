import { AgentrcError } from "../core/errors.js";
import type { AdapterContext } from "./types.js";
import type { ClientId, Manifest, McpServerConfig, SkillConfig } from "../types.js";

export function requireProjectDir(ctx: AdapterContext): string {
  if (ctx.projectDir === undefined) {
    throw new AgentrcError("internal: project scope requires a project directory");
  }
  return ctx.projectDir;
}

/** Servers targeted at a client, honoring per-entry `clients:` restrictions.
 *  Sorted by name for deterministic output. */
export function serversForClient(manifest: Manifest, client: ClientId): Array<[string, McpServerConfig]> {
  return Object.entries(manifest.mcpServers ?? {})
    .filter(([, server]) => server.clients === undefined || server.clients.includes(client))
    .sort(([a], [b]) => a.localeCompare(b));
}

export function skillsForClient(manifest: Manifest, client: ClientId): Array<[string, SkillConfig]> {
  return Object.entries(manifest.skills ?? {})
    .filter(([, skill]) => skill.clients === undefined || skill.clients.includes(client))
    .sort(([a], [b]) => a.localeCompare(b));
}

export function hasEntries(record: Record<string, unknown> | undefined): boolean {
  return record !== undefined && Object.keys(record).length > 0;
}

/** Common stdio rendering shared by every client: { command, args?, env? }. */
export function stdioEntry(server: McpServerConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { command: server.command };
  if (server.args !== undefined && server.args.length > 0) out.args = server.args;
  if (hasEntries(server.env)) out.env = server.env;
  return out;
}

export function headersOf(server: McpServerConfig): Record<string, unknown> {
  return hasEntries(server.headers) ? { headers: server.headers } : {};
}
