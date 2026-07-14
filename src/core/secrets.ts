/**
 * Secret references keep credentials out of your dotfiles repo.
 *
 * Manifest values may contain `${secret:NAME}` references. At sync time the
 * reference is resolved through a chain of backends:
 *
 *   1. environment variables (`NAME`)
 *   2. the OS keychain (macOS `security`, Linux `secret-tool`)
 *   3. the local file store (`~/.agentrc/secrets.json`, chmod 600)
 *
 * `$$` escapes a literal `$` so strings like `$${secret:X}` pass through
 * untouched.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { AgentrcError } from "./errors.js";
import { isPlainObject } from "./merge.js";
import { secretsFilePath } from "./paths.js";

const REF_PATTERN = /\$\$|\$\{secret:([^}]*)\}/g;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export type TemplateToken =
  | { kind: "text"; value: string }
  | { kind: "ref"; name: string };

export function parseTemplate(input: string): TemplateToken[] {
  const tokens: TemplateToken[] = [];
  let last = 0;
  REF_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = REF_PATTERN.exec(input)) !== null) {
    if (match.index > last) {
      tokens.push({ kind: "text", value: input.slice(last, match.index) });
    }
    if (match[0] === "$$") {
      tokens.push({ kind: "text", value: "$" });
    } else {
      const name = match[1] ?? "";
      if (!NAME_PATTERN.test(name)) {
        throw new AgentrcError(
          `invalid secret reference "${match[0]}": secret names must start with a letter or underscore and contain only letters, digits, "_", "-" or "."`,
        );
      }
      tokens.push({ kind: "ref", name });
    }
    last = match.index + match[0].length;
  }
  if (last < input.length) {
    tokens.push({ kind: "text", value: input.slice(last) });
  }
  return tokens;
}

export function renderTemplate(input: string, resolve: (name: string) => string): string {
  return parseTemplate(input)
    .map((t) => (t.kind === "text" ? t.value : resolve(t.name)))
    .join("");
}

/** Collect the unique secret names referenced anywhere in a value tree. */
export function findSecretRefs(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (typeof value === "string") {
    for (const token of parseTemplate(value)) {
      if (token.kind === "ref") acc.add(token.name);
    }
  } else if (Array.isArray(value)) {
    for (const item of value) findSecretRefs(item, acc);
  } else if (isPlainObject(value)) {
    for (const item of Object.values(value)) findSecretRefs(item, acc);
  }
  return acc;
}

/** Replace secret references in every string of a value tree. */
export function resolveDeep<T>(value: T, resolve: (name: string) => string): T {
  if (typeof value === "string") {
    return renderTemplate(value, resolve) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveDeep(item, resolve)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveDeep(v, resolve);
    return out as unknown as T;
  }
  return value;
}

/**
 * Build a redaction function for human-facing text such as diff output.
 * Every occurrence of a resolved secret value — raw, or in the escaped form
 * it takes inside serialized JSON/TOML — is replaced with the
 * `${secret:NAME}` reference it came from, so previews stay readable without
 * exposing the plaintext.
 */
export function createSecretMasker(values: Map<string, string>): (text: string) => string {
  const replacements: Array<{ literal: string; masked: string }> = [];
  for (const [name, value] of values) {
    if (value === "") continue;
    const masked = `\${secret:${name}}`;
    replacements.push({ literal: value, masked });
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) replacements.push({ literal: escaped, masked });
  }
  // Longer literals first, so a value that contains another value as a
  // substring is redacted as a whole rather than partially rewritten.
  replacements.sort((a, b) => b.literal.length - a.literal.length);
  return (text) => {
    let out = text;
    for (const { literal, masked } of replacements) {
      out = out.split(literal).join(masked);
    }
    return out;
  };
}

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

export type BackendId = "env" | "keychain" | "file";

export interface SecretBackend {
  id: BackendId;
  available(): boolean;
  get(name: string): string | undefined;
  set?(name: string, value: string): void;
  remove?(name: string): void;
  list?(): string[];
}

export function createEnvBackend(env: NodeJS.ProcessEnv = process.env): SecretBackend {
  return {
    id: "env",
    available: () => true,
    get: (name) => env[name],
  };
}

export function createFileBackend(filePath: string): SecretBackend {
  const read = (): Record<string, string> => {
    if (!fs.existsSync(filePath)) return {};
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
      throw new AgentrcError(`${filePath}: invalid JSON in secret store: ${(err as Error).message}`);
    }
    if (!isPlainObject(data)) {
      throw new AgentrcError(`${filePath}: secret store must be a JSON object of string values`);
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v !== "string") {
        throw new AgentrcError(`${filePath}: secret "${k}" is not a string`);
      }
      out[k] = v;
    }
    return out;
  };
  const write = (data: Record<string, string>): void => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
  };
  return {
    id: "file",
    available: () => true,
    get: (name) => read()[name],
    set: (name, value) => write({ ...read(), [name]: value }),
    remove: (name) => {
      const data = read();
      delete data[name];
      write(data);
    },
    list: () => Object.keys(read()).sort(),
  };
}

export interface ExecResult {
  status: number;
  stdout: string;
}

export type ExecFn = (cmd: string, args: string[], input?: string) => ExecResult;

const defaultExec: ExecFn = (cmd, args, input) => {
  try {
    const stdout = execFileSync(cmd, args, {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: unknown };
    return { status: typeof e.status === "number" ? e.status : 1, stdout: String(e.stdout ?? "") };
  }
};

export function commandExists(cmd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const pathVar = env.PATH ?? "";
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    try {
      fs.accessSync(path.join(dir, cmd), fs.constants.X_OK);
      return true;
    } catch {
      // keep scanning
    }
  }
  return false;
}

export interface KeychainOptions {
  platform?: NodeJS.Platform;
  exec?: ExecFn;
  hasCommand?: (cmd: string) => boolean;
}

const KEYCHAIN_SERVICE = "agentrc";

/** OS keychain backend. macOS uses `security`; Linux uses `secret-tool`
 *  (libsecret). Both are shelled out so they can be injected in tests. */
export function createKeychainBackend(opts: KeychainOptions = {}): SecretBackend {
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec ?? defaultExec;
  const has = opts.hasCommand ?? commandExists;

  if (platform === "darwin") {
    return {
      id: "keychain",
      available: () => has("security"),
      get: (name) => {
        const r = exec("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"]);
        return r.status === 0 ? r.stdout.replace(/\n$/, "") : undefined;
      },
      set: (name, value) => {
        const r = exec("security", ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", name, "-w", value]);
        if (r.status !== 0) throw new AgentrcError(`keychain: failed to store secret "${name}" (security exited ${r.status})`);
      },
      remove: (name) => {
        exec("security", ["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name]);
      },
    };
  }

  return {
    id: "keychain",
    available: () => platform === "linux" && has("secret-tool"),
    get: (name) => {
      const r = exec("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "account", name]);
      if (r.status !== 0) return undefined;
      const value = r.stdout.replace(/\n$/, "");
      return value === "" ? undefined : value;
    },
    set: (name, value) => {
      const r = exec(
        "secret-tool",
        ["store", "--label", `${KEYCHAIN_SERVICE}/${name}`, "service", KEYCHAIN_SERVICE, "account", name],
        value,
      );
      if (r.status !== 0) throw new AgentrcError(`keychain: failed to store secret "${name}" (secret-tool exited ${r.status})`);
    },
    remove: (name) => {
      exec("secret-tool", ["clear", "service", KEYCHAIN_SERVICE, "account", name]);
    },
  };
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

export interface ResolvedSecret {
  value: string;
  backend: BackendId;
}

/** A secret that resolved from an earlier backend while a later store also
 *  holds a value under the same name (e.g. an ambient env var hiding a value
 *  the user explicitly stored with `agentrc secret set`). */
export interface ShadowedSecret {
  name: string;
  used: BackendId;
  over: BackendId;
}

export class SecretResolver {
  constructor(readonly backends: SecretBackend[]) {}

  lookup(name: string): ResolvedSecret | undefined {
    for (const backend of this.backends) {
      if (!backend.available()) continue;
      const value = backend.get(name);
      if (value !== undefined) return { value, backend: backend.id };
    }
    return undefined;
  }

  /** The first writable store (keychain/file) after `used` that also holds
   *  `name`, or undefined when nothing is shadowed. */
  shadowedStore(name: string, used: BackendId): BackendId | undefined {
    let seen = false;
    for (const backend of this.backends) {
      if (!seen) {
        if (backend.id === used) seen = true;
        continue;
      }
      if (typeof backend.set !== "function") continue; // only explicit stores
      if (!backend.available()) continue;
      if (backend.get(name) !== undefined) return backend.id;
    }
    return undefined;
  }

  resolveAll(names: Iterable<string>): {
    values: Map<string, string>;
    missing: string[];
    shadowed: ShadowedSecret[];
  } {
    const values = new Map<string, string>();
    const missing: string[] = [];
    const shadowed: ShadowedSecret[] = [];
    for (const name of names) {
      const hit = this.lookup(name);
      if (hit) {
        values.set(name, hit.value);
        if (hit.backend === "env") {
          const over = this.shadowedStore(name, hit.backend);
          if (over !== undefined) shadowed.push({ name, used: hit.backend, over });
        }
      } else {
        missing.push(name);
      }
    }
    shadowed.sort((a, b) => a.name.localeCompare(b.name));
    return { values, missing: missing.sort(), shadowed };
  }

  /** The first backend that supports writes and is available (keychain
   *  preferred over the file store). */
  writableBackend(preferred?: BackendId): SecretBackend | undefined {
    const candidates = this.backends.filter((b) => typeof b.set === "function");
    if (preferred) return candidates.find((b) => b.id === preferred && b.available());
    return candidates.find((b) => b.available());
  }

  backendsInfo(): Array<{ id: BackendId; available: boolean; writable: boolean }> {
    return this.backends.map((b) => ({
      id: b.id,
      available: b.available(),
      writable: typeof b.set === "function" && b.available(),
    }));
  }
}

/** Standard chain: env > keychain > file store under `<home>/.agentrc/`. */
export function defaultBackends(home: string, opts: KeychainOptions = {}): SecretBackend[] {
  return [createEnvBackend(), createKeychainBackend(opts), createFileBackend(secretsFilePath(home))];
}

export function defaultResolver(home: string, opts: KeychainOptions = {}): SecretResolver {
  return new SecretResolver(defaultBackends(home, opts));
}
