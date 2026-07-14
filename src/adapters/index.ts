import { AgentrcError } from "../core/errors.js";
import { CLIENT_IDS, isClientId, type ClientId, type Manifest } from "../types.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codexAdapter } from "./codex.js";
import { cursorAdapter } from "./cursor.js";
import { geminiAdapter } from "./gemini.js";
import type { Adapter } from "./types.js";

export const ADAPTERS: Record<ClientId, Adapter> = {
  "claude-code": claudeCodeAdapter,
  codex: codexAdapter,
  cursor: cursorAdapter,
  "gemini-cli": geminiAdapter,
};

export function getAdapter(id: string): Adapter {
  if (!isClientId(id)) {
    throw new AgentrcError(`unknown client "${id}" (expected one of: ${CLIENT_IDS.join(", ")})`);
  }
  return ADAPTERS[id];
}

/** Which clients does this run target? Explicit --client flags win, then the
 *  manifest's `clients:` list, then every supported client. */
export function selectClients(manifest: Manifest, explicit?: ClientId[]): ClientId[] {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  if (manifest.clients !== undefined && manifest.clients.length > 0) return [...manifest.clients];
  return [...CLIENT_IDS];
}
