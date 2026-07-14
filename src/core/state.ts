import fs from "node:fs";
import { AgentrcError } from "./errors.js";
import { writeFileAtomic } from "./fsio.js";
import { isPlainObject } from "./merge.js";
import { statePath } from "./paths.js";

/**
 * agentrc only ever touches what it wrote. The state file records, per client
 * config file, which record entries (e.g. which mcpServers names) and which
 * whole keys (e.g. "hooks") are managed — so removing something from the
 * manifest removes it from client configs on the next sync, while entries the
 * user added by hand are never touched.
 */

export interface FileState {
  /** keyPath (joined with ".") -> managed entry names, e.g. { "mcpServers": ["github"] } */
  records: Record<string, string[]>;
  /** whole keys owned by agentrc, e.g. ["hooks", "permissions"] */
  keys: string[];
}

export interface AgentrcState {
  version: 1;
  files: Record<string, FileState>;
  /** directories agentrc created (installed skills) */
  dirs: string[];
}

export function emptyState(): AgentrcState {
  return { version: 1, files: {}, dirs: [] };
}

export function emptyFileState(): FileState {
  return { records: {}, keys: [] };
}

export function loadState(home: string): AgentrcState {
  const file = statePath(home);
  if (!fs.existsSync(file)) return emptyState();
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new AgentrcError(`${file}: state file is corrupt (${(err as Error).message}); fix or delete it`);
  }
  if (!isPlainObject(data) || data.version !== 1 || !isPlainObject(data.files) || !Array.isArray(data.dirs)) {
    throw new AgentrcError(`${file}: unrecognized state file format; fix or delete it`);
  }
  return data as unknown as AgentrcState;
}

export function saveState(home: string, state: AgentrcState): void {
  writeFileAtomic(statePath(home), `${JSON.stringify(state, null, 2)}\n`);
}
