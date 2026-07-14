import { AgentrcError } from "../core/errors.js";

export interface FlagDef {
  name: string;
  alias?: string;
  takesValue: boolean;
  repeatable?: boolean;
}

export interface Parsed {
  flags: Record<string, string | boolean | string[]>;
  positionals: string[];
}

export function parseArgs(argv: string[], defs: FlagDef[]): Parsed {
  const flags: Parsed["flags"] = {};
  const positionals: string[] = [];
  const byName = new Map(defs.map((d) => [d.name, d]));
  const byAlias = new Map(defs.filter((d) => d.alias !== undefined).map((d) => [d.alias!, d]));

  let i = 0;
  while (i < argv.length) {
    const token = argv[i]!;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    let def: FlagDef | undefined;
    let inlineValue: string | undefined;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      if (eq !== -1) inlineValue = token.slice(eq + 1);
      def = byName.get(name);
      if (def === undefined) {
        throw new AgentrcError(`unknown option "--${name}" (see: agentrc help)`, 2);
      }
    } else if (token.startsWith("-") && token.length > 1) {
      def = byAlias.get(token.slice(1));
      if (def === undefined) {
        throw new AgentrcError(`unknown option "${token}" (see: agentrc help)`, 2);
      }
    } else {
      positionals.push(token);
      i++;
      continue;
    }

    if (!def.takesValue) {
      if (inlineValue !== undefined) {
        throw new AgentrcError(`option "--${def.name}" does not take a value`, 2);
      }
      flags[def.name] = true;
      i++;
      continue;
    }

    let value: string;
    if (inlineValue !== undefined) {
      value = inlineValue;
    } else {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new AgentrcError(`option "--${def.name}" requires a value`, 2);
      }
      value = next;
      i++;
    }
    if (def.repeatable === true) {
      const existing = flags[def.name];
      if (Array.isArray(existing)) existing.push(value);
      else flags[def.name] = [value];
    } else {
      flags[def.name] = value;
    }
    i++;
  }
  return { flags, positionals };
}

export function flagStr(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags[name];
  return typeof value === "string" ? value : undefined;
}

export function flagBool(parsed: Parsed, name: string): boolean {
  return parsed.flags[name] === true;
}

export function flagList(parsed: Parsed, name: string): string[] {
  const value = parsed.flags[name];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return [value];
  return [];
}
