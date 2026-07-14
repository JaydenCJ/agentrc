/**
 * Core manifest types. The agentrc manifest (agentrc.yaml) is the single
 * source of truth; adapters convert it to each client's native format.
 */

export const CLIENT_IDS = ["claude-code", "codex", "cursor", "gemini-cli"] as const;
export type ClientId = (typeof CLIENT_IDS)[number];

export function isClientId(value: unknown): value is ClientId {
  return typeof value === "string" && (CLIENT_IDS as readonly string[]).includes(value);
}

export type Transport = "stdio" | "http" | "sse";
export const TRANSPORTS: readonly Transport[] = ["stdio", "http", "sse"];

export interface McpServerConfig {
  /** Inferred when omitted: "stdio" if `command` is set, "http" if `url` is set. */
  transport?: Transport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** Restrict this server to a subset of clients. Default: all targeted clients. */
  clients?: ClientId[];
}

export interface SkillConfig {
  /** Directory containing the skill (usually with a SKILL.md). Relative paths
   *  are resolved against the manifest file that declares them. */
  path: string;
  clients?: ClientId[];
}

export const HOOK_EVENTS = [
  "preToolUse",
  "postToolUse",
  "userPromptSubmit",
  "sessionStart",
  "sessionEnd",
  "stop",
  "subagentStop",
  "preCompact",
  "notification",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HookEntry {
  matcher?: string;
  command: string;
  timeout?: number;
}

export type HooksConfig = Partial<Record<HookEvent, HookEntry[]>>;

export interface PermissionsConfig {
  allow?: string[];
  deny?: string[];
  ask?: string[];
  defaultMode?: string;
}

export interface Manifest {
  version: number;
  /** Paths of preset manifests to merge underneath this one (team presets). */
  extends?: string[];
  /** Clients to sync. Default: all supported clients. */
  clients?: ClientId[];
  mcpServers?: Record<string, McpServerConfig>;
  skills?: Record<string, SkillConfig>;
  hooks?: HooksConfig;
  permissions?: PermissionsConfig;
}

/** A manifest fragment: presets and project overlays may omit `version`. */
export type ManifestFragment = Partial<Manifest>;
