import fs from "node:fs";
import { flagStr, type Parsed } from "../cli/args.js";
import { buildContext, type CliIO } from "../cli/context.js";
import { AgentrcError } from "../core/errors.js";
import { defaultResolver, type BackendId } from "../core/secrets.js";

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function readValueFromStdin(): string {
  if (process.stdin.isTTY) {
    throw new AgentrcError(
      "provide a value argument or pipe the value on stdin (e.g. `pbpaste | agentrc secret set NAME`)",
    );
  }
  const raw = fs.readFileSync(0, "utf8");
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

export function cmdSecret(parsed: Parsed, io: CliIO): number {
  const sub = parsed.positionals[0];
  const ctx = buildContext(parsed);
  const resolver = defaultResolver(ctx.home);

  switch (sub) {
    case "set": {
      const name = requireName(parsed);
      const value = parsed.positionals[2] ?? readValueFromStdin();
      const store = flagStr(parsed, "store");
      if (store !== undefined && store !== "keychain" && store !== "file") {
        throw new AgentrcError(`--store must be "keychain" or "file"`);
      }
      const backend = resolver.writableBackend(store as BackendId | undefined);
      if (backend === undefined || backend.set === undefined) {
        throw new AgentrcError(
          store !== undefined
            ? `secret backend "${store}" is not available on this machine`
            : "no writable secret backend available",
        );
      }
      backend.set(name, value);
      io.err(`stored secret "${name}" in ${backend.id} store`);
      if (backend.id === "file") {
        io.err("(plain-file store at <home>/.agentrc/secrets.json, chmod 600; an OS keychain is preferred when available)");
      }
      if (process.env[name] !== undefined) {
        io.err(
          `warning: $${name} is also set in your environment; env takes precedence at sync time, so the stored value will be shadowed until you unset it`,
        );
      }
      return 0;
    }
    case "get": {
      const name = requireName(parsed);
      const hit = resolver.lookup(name);
      if (hit === undefined) {
        io.err(`agentrc: secret "${name}" not found (checked: env, keychain, file store)`);
        return 1;
      }
      io.out(hit.value);
      return 0;
    }
    case "list": {
      let printed = false;
      for (const backend of resolver.backends) {
        if (backend.list === undefined || !backend.available()) continue;
        for (const name of backend.list()) {
          io.out(`${name}\t(${backend.id})`);
          printed = true;
        }
      }
      if (resolver.backends.some((b) => b.id === "keychain" && b.available())) {
        io.err("note: keychain entries are not enumerable; use `agentrc secret get NAME`");
      }
      if (!printed) io.err("no secrets in the file store");
      return 0;
    }
    case "rm":
    case "remove": {
      const name = requireName(parsed);
      let removed = false;
      for (const backend of resolver.backends) {
        if (backend.remove !== undefined && backend.available() && backend.get(name) !== undefined) {
          backend.remove(name);
          io.err(`removed secret "${name}" from ${backend.id} store`);
          removed = true;
        }
      }
      if (!removed) {
        io.err(`agentrc: secret "${name}" not found in any writable store`);
        return 1;
      }
      return 0;
    }
    default:
      io.err("usage: agentrc secret <set|get|list|rm> [name] [value]");
      return 2;
  }
}

function requireName(parsed: Parsed): string {
  const name = parsed.positionals[1];
  if (name === undefined) {
    throw new AgentrcError("missing secret name (usage: agentrc secret <set|get|rm> NAME [value])", 2);
  }
  if (!NAME_PATTERN.test(name)) {
    throw new AgentrcError(
      `invalid secret name "${name}" (letters, digits, "_", "-", "." only; must not start with a digit)`,
    );
  }
  return name;
}
