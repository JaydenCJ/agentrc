import { describe, expect, it } from "vitest";
import { parseArgs, type FlagDef } from "../src/cli/args.js";
import { AgentrcError } from "../src/core/errors.js";

const DEFS: FlagDef[] = [
  { name: "home", takesValue: true },
  { name: "client", takesValue: true, repeatable: true },
  { name: "dry-run", takesValue: false },
  { name: "output", alias: "o", takesValue: true },
];

describe("parseArgs", () => {
  it("separates flags from positionals regardless of order", () => {
    const parsed = parseArgs(["--home", "/h", "sync", "--dry-run"], DEFS);
    expect(parsed.flags.home).toBe("/h");
    expect(parsed.flags["dry-run"]).toBe(true);
    expect(parsed.positionals).toEqual(["sync"]);
  });

  it("supports --flag=value and short aliases", () => {
    const parsed = parseArgs(["--home=/elsewhere", "-o", "out.yaml"], DEFS);
    expect(parsed.flags.home).toBe("/elsewhere");
    expect(parsed.flags.output).toBe("out.yaml");
  });

  it("collects repeatable flags into arrays", () => {
    const parsed = parseArgs(["--client", "codex", "--client", "cursor"], DEFS);
    expect(parsed.flags.client).toEqual(["codex", "cursor"]);
  });

  it("rejects unknown options with exit code 2", () => {
    try {
      parseArgs(["--nope"], DEFS);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(AgentrcError);
      expect((err as AgentrcError).exitCode).toBe(2);
    }
  });

  it("rejects a value flag without a value and a boolean flag with one", () => {
    expect(() => parseArgs(["--home"], DEFS)).toThrow(/requires a value/);
    expect(() => parseArgs(["--dry-run=yes"], DEFS)).toThrow(/does not take a value/);
  });

  it("treats everything after -- as positionals", () => {
    const parsed = parseArgs(["set", "--", "--not-a-flag"], DEFS);
    expect(parsed.positionals).toEqual(["set", "--not-a-flag"]);
  });
});
