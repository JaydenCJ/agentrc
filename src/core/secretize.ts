import type { ManifestFragment } from "../types.js";
import { clone } from "./merge.js";

/** Keys whose values look like credentials. Used by `agentrc import` to move
 *  plaintext out of the generated manifest and into the secret store. */
const SECRETISH = /(token|secret|passwd|password|api[-_]?key|apikey|credential|auth)/i;

export interface ExtractedSecret {
  name: string;
  /** e.g. `mcpServers.github.env.GITHUB_TOKEN` */
  location: string;
  value: string;
}

export function looksSecret(key: string): boolean {
  return SECRETISH.test(key);
}

export function sanitizeSecretName(raw: string): string {
  let name = raw.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  if (!/^[A-Z_]/.test(name)) name = `_${name}`;
  return name;
}

/** Replace credential-looking env/header values in an imported fragment with
 *  `${secret:NAME}` references. Returns the rewritten fragment plus the list
 *  of extracted (name, value) pairs so they can be stored. */
export function secretizeFragment(fragment: ManifestFragment): {
  fragment: ManifestFragment;
  extracted: ExtractedSecret[];
} {
  const out = clone(fragment);
  const extracted: ExtractedSecret[] = [];
  const assigned = new Map<string, string>(); // secret name -> value

  const pickName = (serverName: string, key: string, value: string): string => {
    const base = sanitizeSecretName(key);
    const existing = assigned.get(base);
    if (existing === undefined || existing === value) {
      assigned.set(base, value);
      return base;
    }
    // Same key with a different value on another server: prefix server name.
    let candidate = `${sanitizeSecretName(serverName)}_${base}`;
    let n = 2;
    while (assigned.has(candidate) && assigned.get(candidate) !== value) {
      candidate = `${sanitizeSecretName(serverName)}_${base}_${n}`;
      n++;
    }
    assigned.set(candidate, value);
    return candidate;
  };

  for (const [serverName, server] of Object.entries(out.mcpServers ?? {})) {
    for (const field of ["env", "headers"] as const) {
      const record = server[field];
      if (record === undefined) continue;
      for (const [key, value] of Object.entries(record)) {
        if (typeof value !== "string" || value === "") continue;
        if (value.includes("${secret:")) continue; // already a reference
        if (!looksSecret(key)) continue;
        const name = pickName(serverName, key, value);
        record[key] = `\${secret:${name}}`;
        extracted.push({ name, location: `mcpServers.${serverName}.${field}.${key}`, value });
      }
    }
  }

  // De-duplicate identical (name, value) extractions from multiple locations.
  const unique = new Map<string, ExtractedSecret>();
  for (const item of extracted) {
    if (!unique.has(item.name)) unique.set(item.name, item);
  }
  return { fragment: out, extracted: [...unique.values()] };
}
