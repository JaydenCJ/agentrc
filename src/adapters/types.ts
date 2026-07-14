import type { ClientId, Manifest, ManifestFragment, Transport } from "../types.js";

export type Scope = "user" | "project";

export interface AdapterContext {
  home: string;
  scope: Scope;
  /** Set when scope === "project". */
  projectDir?: string;
}

/** One mutation of a JSON/TOML document.
 *  - merge-record: merge `entries` into the record at `keyPath`, preserving
 *    entries agentrc does not manage and removing previously-managed entries
 *    that disappeared from the manifest.
 *  - replace-key: agentrc owns the whole key (e.g. "hooks"). */
export type JsonSetOp =
  | { mode: "merge-record"; keyPath: string[]; entries: Record<string, unknown> }
  | { mode: "replace-key"; keyPath: string[]; value: unknown };

export interface FilePlan {
  path: string;
  format: "json" | "toml";
  sets: JsonSetOp[];
}

export interface DirPlan {
  name: string;
  source: string;
  target: string;
}

export interface AdapterPlanResult {
  files: FilePlan[];
  dirs: DirPlan[];
  warnings: string[];
}

export interface Capabilities {
  mcpServers: boolean;
  hooks: boolean;
  permissions: boolean;
  skills: boolean;
  transports: Transport[];
  projectScope: boolean;
}

export interface DetectResult {
  detected: boolean;
  evidence?: string;
}

export interface ImportResult {
  fragment: ManifestFragment;
  /** Files that were actually read. */
  sources: string[];
}

export interface Adapter {
  id: ClientId;
  title: string;
  capabilities: Capabilities;
  /** Config files this adapter writes in the given context. */
  configPaths(ctx: AdapterContext): string[];
  /** Is the client present on this machine? */
  detect(ctx: AdapterContext): DetectResult;
  /** Convert the (already merged + secret-resolved) manifest into concrete
   *  file mutations for this client. */
  plan(manifest: Manifest, ctx: AdapterContext): AdapterPlanResult;
  /** Reverse conversion: read the client's native config back into manifest
   *  form (used by `agentrc import`). */
  importConfig(ctx: AdapterContext): ImportResult;
  /** Where this adapter installs skills, if it supports them. Used to clean
   *  up skills that were removed from the manifest. */
  skillsDir(ctx: AdapterContext): string | undefined;
}
