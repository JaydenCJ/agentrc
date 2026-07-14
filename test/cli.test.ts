import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import type { CliIO } from "../src/cli/context.js";
import { makeTmpDir, readJson, rmrf, write } from "./helpers.js";

let home: string;
let out: string[];
let err: string[];
let io: CliIO;

beforeEach(() => {
  home = makeTmpDir();
  out = [];
  err = [];
  io = { out: (l) => out.push(l), err: (l) => err.push(l) };
});
afterEach(() => {
  rmrf(home);
});

function agentrc(...argv: string[]): number {
  return run(["--home", home, ...argv], io);
}

describe("CLI end-to-end (init -> secret -> sync -> status -> import)", () => {
  it("runs the full headline flow against a sandbox home", () => {
    expect(agentrc("init")).toBe(0);
    const configPath = path.join(home, ".agentrc", "agentrc.yaml");
    expect(fs.existsSync(configPath)).toBe(true);

    // init refuses to clobber without --force
    expect(agentrc("init")).toBe(1);

    write(
      configPath,
      [
        "version: 1",
        "clients: [claude-code, codex, cursor, gemini-cli]",
        "mcpServers:",
        "  github:",
        "    command: npx",
        '    args: ["-y", "@modelcontextprotocol/server-github"]',
        "    env:",
        '      GITHUB_TOKEN: "${secret:AGENTRC_CLI_TEST_TOKEN}"',
        "",
      ].join("\n"),
    );

    // secret set via positional value; force the file store for determinism
    expect(agentrc("secret", "set", "AGENTRC_CLI_TEST_TOKEN", "tok-42", "--store", "file")).toBe(0);
    out = [];
    expect(agentrc("secret", "get", "AGENTRC_CLI_TEST_TOKEN")).toBe(0);
    expect(out).toEqual(["tok-42"]);

    // status --check reports drift before the first sync
    expect(agentrc("status", "--check")).toBe(1);

    expect(agentrc("sync")).toBe(0);
    const claude = readJson(path.join(home, ".claude.json")) as {
      mcpServers: { github: { env: Record<string, string> } };
    };
    expect(claude.mcpServers.github.env.GITHUB_TOKEN).toBe("tok-42");
    expect(fs.existsSync(path.join(home, ".codex", "config.toml"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".cursor", "mcp.json"))).toBe(true);
    expect(fs.existsSync(path.join(home, ".gemini", "settings.json"))).toBe(true);

    // after sync everything is in sync
    expect(agentrc("status", "--check")).toBe(0);

    // diff says so, too
    out = [];
    expect(agentrc("diff")).toBe(0);
    expect(out.join("\n")).toContain("everything in sync");

    // import round-trip: cursor config back to manifest YAML on stdout
    out = [];
    expect(agentrc("import", "cursor", "--no-secretize")).toBe(0);
    const yamlText = out.join("\n");
    expect(yamlText).toContain("github:");
    expect(yamlText).toContain("command: npx");
  });

  it("prints help and version", () => {
    expect(agentrc("help")).toBe(0);
    expect(out.join("\n")).toContain("Usage: agentrc <command>");
    out = [];
    expect(agentrc("--version")).toBe(0);
    expect(out[0]).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("fails with exit code 2 for unknown commands", () => {
    expect(() => agentrc("frobnicate")).toThrow(/unknown command/);
  });

  it("secret get returns 1 for a missing secret", () => {
    expect(agentrc("secret", "get", "AGENTRC_DEFINITELY_MISSING_XYZ")).toBe(1);
    expect(err.join("\n")).toContain("not found");
  });

  it("import -o refuses to overwrite without --force", () => {
    fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
    write(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { x: { command: "y" } } }));
    const target = path.join(home, "imported.yaml");
    expect(agentrc("import", "cursor", "-o", target)).toBe(0);
    expect(agentrc("import", "cursor", "-o", target)).toBe(1);
    expect(agentrc("import", "cursor", "-o", target, "--force")).toBe(0);
  });

  it("diff redacts resolved secret values instead of printing plaintext", () => {
    const configPath = path.join(home, ".agentrc", "agentrc.yaml");
    write(
      configPath,
      [
        "version: 1",
        "clients: [claude-code, codex, cursor, gemini-cli]",
        "mcpServers:",
        "  github:",
        "    command: npx",
        '    args: ["-y", "@modelcontextprotocol/server-github"]',
        "    env:",
        '      TOKEN1: "${secret:GH_MCP_TOKEN}"',
        '      TOKEN2: "${secret:GH_MCP_TOKEN}"',
        "",
      ].join("\n"),
    );
    expect(agentrc("secret", "set", "GH_MCP_TOKEN", "ghp_leaktest123", "--store", "file")).toBe(0);

    out = [];
    expect(agentrc("diff")).toBe(0);
    const text = out.join("\n");
    expect(text).not.toContain("ghp_leaktest123");
    expect(text).toContain("${secret:GH_MCP_TOKEN}");

    // The JSON report embeds the same diff text, so it is redacted too.
    out = [];
    expect(agentrc("diff", "--json")).toBe(0);
    const jsonText = out.join("\n");
    expect(jsonText).not.toContain("ghp_leaktest123");
    expect(jsonText).toContain("${secret:GH_MCP_TOKEN}");
  });

  it("secretizes credentials during import and can save them to the store", () => {
    fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
    write(
      path.join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { svc: { command: "run", env: { SVC_API_TOKEN: "sk-live-1" } } } }),
    );
    out = [];
    expect(agentrc("import", "cursor", "--save-secrets", "--store", "file")).toBe(0);
    const yamlText = out.join("\n");
    expect(yamlText).toContain("${secret:SVC_API_TOKEN}");
    expect(yamlText).not.toContain("sk-live-1");
    const store = readJson(path.join(home, ".agentrc", "secrets.json")) as Record<string, string>;
    expect(store.SVC_API_TOKEN).toBe("sk-live-1");
  });
});
