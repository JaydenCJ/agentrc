import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runEngine, type EngineOptions } from "../src/core/engine.js";
import { createEnvBackend, createFileBackend, SecretResolver } from "../src/core/secrets.js";
import { makeTmpDir, readJson, rmrf, write } from "./helpers.js";

let home: string;
let work: string;

beforeEach(() => {
  home = makeTmpDir();
  work = makeTmpDir();
});
afterEach(() => {
  rmrf(home);
  rmrf(work);
});

function writeConfig(yaml: string): string {
  const file = path.join(home, ".agentrc", "agentrc.yaml");
  write(file, yaml);
  return file;
}

function options(extra: Partial<EngineOptions> = {}): EngineOptions {
  return {
    home,
    configPath: path.join(home, ".agentrc", "agentrc.yaml"),
    write: true,
    resolver: new SecretResolver([createEnvBackend({ AGENTRC_TEST_TOKEN: "resolved-token" })]),
    ...extra,
  };
}

const BASE_YAML = `version: 1
clients: [claude-code, codex, cursor, gemini-cli]
mcpServers:
  github:
    command: npx
    args: ["-y", "@modelcontextprotocol/server-github"]
    env:
      GITHUB_TOKEN: "\${secret:AGENTRC_TEST_TOKEN}"
  docs:
    transport: http
    url: https://mcp.example.com/docs
permissions:
  allow: ["Bash(npm run *)"]
hooks:
  preToolUse:
    - matcher: Bash
      command: ./guard.sh
`;

describe("sync engine", () => {
  it("creates all four client configs from one manifest (headline scenario)", () => {
    writeConfig(BASE_YAML);
    const report = runEngine(options());

    const claude = readJson(path.join(home, ".claude.json")) as {
      mcpServers: Record<string, { env?: Record<string, string> }>;
    };
    expect(Object.keys(claude.mcpServers).sort()).toEqual(["docs", "github"]);
    expect(claude.mcpServers.github!.env!.GITHUB_TOKEN).toBe("resolved-token");

    const settings = readJson(path.join(home, ".claude", "settings.json")) as Record<string, unknown>;
    expect(settings.permissions).toEqual({ allow: ["Bash(npm run *)"] });
    expect(settings.hooks).toBeDefined();

    const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    expect(toml).toContain("[mcp_servers.github]");
    expect(toml).toContain('GITHUB_TOKEN = "resolved-token"');
    expect(toml).not.toContain("docs"); // http server skipped for codex

    const cursor = readJson(path.join(home, ".cursor", "mcp.json")) as { mcpServers: Record<string, unknown> };
    expect(cursor.mcpServers.docs).toEqual({ url: "https://mcp.example.com/docs" });

    const gemini = readJson(path.join(home, ".gemini", "settings.json")) as { mcpServers: Record<string, unknown> };
    expect(gemini.mcpServers.docs).toEqual({ httpUrl: "https://mcp.example.com/docs" });

    expect(report.changed).toBe(true);
    expect(report.files.filter((f) => f.action === "create")).toHaveLength(5);
  });

  it("is idempotent: a second sync reports everything unchanged", () => {
    writeConfig(BASE_YAML);
    runEngine(options());
    const second = runEngine(options());
    expect(second.changed).toBe(false);
    expect(second.files.every((f) => f.action === "unchanged" || f.action === "skip")).toBe(true);
  });

  it("preserves entries the user added by hand", () => {
    write(
      path.join(home, ".claude.json"),
      JSON.stringify({
        numStartups: 42,
        mcpServers: { mine: { type: "stdio", command: "my-server" } },
      }),
    );
    writeConfig(BASE_YAML);
    runEngine(options());
    const claude = readJson(path.join(home, ".claude.json")) as {
      numStartups: number;
      mcpServers: Record<string, unknown>;
    };
    expect(claude.numStartups).toBe(42);
    expect(claude.mcpServers.mine).toEqual({ type: "stdio", command: "my-server" });
    expect(Object.keys(claude.mcpServers).sort()).toEqual(["docs", "github", "mine"]);
  });

  it("removes servers dropped from the manifest but never user-owned ones", () => {
    write(
      path.join(home, ".claude.json"),
      JSON.stringify({ mcpServers: { mine: { type: "stdio", command: "my-server" } } }),
    );
    writeConfig(BASE_YAML);
    runEngine(options());
    // Drop "docs" from the manifest.
    writeConfig(BASE_YAML.replace("  docs:\n    transport: http\n    url: https://mcp.example.com/docs\n", ""));
    const report = runEngine(options());
    const claude = readJson(path.join(home, ".claude.json")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(claude.mcpServers).sort()).toEqual(["github", "mine"]);
    const action = report.files.find((f) => f.path === path.join(home, ".claude.json"));
    expect(action?.changes).toContain("- mcpServers.docs");
  });

  it("removes managed whole keys (hooks) when they leave the manifest, keeping user settings", () => {
    write(
      path.join(home, ".claude", "settings.json"),
      JSON.stringify({ model: "opus", theme: "dark" }),
    );
    writeConfig(BASE_YAML);
    runEngine(options());
    let settings = readJson(path.join(home, ".claude", "settings.json")) as Record<string, unknown>;
    expect(settings.hooks).toBeDefined();
    expect(settings.model).toBe("opus");

    // Remove hooks + permissions from the manifest entirely.
    const withoutHooks = BASE_YAML.split("permissions:")[0]!;
    writeConfig(withoutHooks);
    runEngine(options());
    settings = readJson(path.join(home, ".claude", "settings.json")) as Record<string, unknown>;
    expect(settings.hooks).toBeUndefined();
    expect(settings.permissions).toBeUndefined();
    expect(settings.model).toBe("opus");
    expect(settings.theme).toBe("dark");
  });

  it("installs, updates and removes skill directories", () => {
    const skillSrc = path.join(work, "skills", "review");
    write(path.join(skillSrc, "SKILL.md"), "# review v1\n");
    writeConfig(`version: 1\nclients: [claude-code]\nskills:\n  review:\n    path: ${skillSrc}\n`);

    let report = runEngine(options());
    const target = path.join(home, ".claude", "skills", "review");
    expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toBe("# review v1\n");
    expect(report.dirs[0]?.action).toBe("create");

    // Update the source; sync copies the new content.
    write(path.join(skillSrc, "SKILL.md"), "# review v2\n");
    report = runEngine(options());
    expect(report.dirs[0]?.action).toBe("update");
    expect(fs.readFileSync(path.join(target, "SKILL.md"), "utf8")).toBe("# review v2\n");

    // Remove the skill from the manifest; sync cleans up the installed copy.
    writeConfig("version: 1\nclients: [claude-code]\n");
    report = runEngine(options());
    expect(fs.existsSync(target)).toBe(false);
    expect(report.dirs.some((d) => d.action === "remove" && d.target === target)).toBe(true);
  });

  it("does not touch other clients' skills when syncing a single client", () => {
    const skillSrc = path.join(work, "skills", "review");
    write(path.join(skillSrc, "SKILL.md"), "# review\n");
    writeConfig(`version: 1\nclients: [claude-code, cursor]\nskills:\n  review:\n    path: ${skillSrc}\n`);
    runEngine(options());
    const target = path.join(home, ".claude", "skills", "review");
    expect(fs.existsSync(target)).toBe(true);

    // Sync only cursor with a manifest that no longer has the skill: the
    // installed Claude skill must survive.
    writeConfig("version: 1\nclients: [claude-code, cursor]\n");
    runEngine(options({ clients: ["cursor"] }));
    expect(fs.existsSync(target)).toBe(true);

    // Now sync claude-code too: cleanup happens.
    runEngine(options());
    expect(fs.existsSync(target)).toBe(false);
  });

  it("writes a .agentrc.bak backup before the first overwrite", () => {
    write(path.join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: {} }));
    writeConfig(BASE_YAML);
    runEngine(options());
    const backup = path.join(home, ".cursor", "mcp.json.agentrc.bak");
    expect(fs.existsSync(backup)).toBe(true);
    expect(readJson(backup)).toEqual({ mcpServers: {} });
  });

  it("dry-run (write: false) computes the plan but writes nothing", () => {
    writeConfig(BASE_YAML);
    const report = runEngine(options({ write: false }));
    expect(report.changed).toBe(true);
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".codex"))).toBe(false);
  });

  it("fails before writing anything when a secret is missing", () => {
    writeConfig(BASE_YAML);
    expect(() => runEngine(options({ resolver: new SecretResolver([createEnvBackend({})]) }))).toThrow(
      /missing secrets: AGENTRC_TEST_TOKEN/,
    );
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
  });

  it("fails before writing anything when a skill source directory is missing", () => {
    const missing = path.join(work, "skills", "ghost");
    writeConfig(
      `version: 1
clients: [claude-code, cursor]
mcpServers:
  github:
    command: npx
skills:
  ghost:
    path: ${missing}
`,
    );
    expect(() => runEngine(options())).toThrow(/skill "ghost": source directory not found/);
    // Nothing was written for any client and no state was recorded.
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".cursor"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".agentrc", "state.json"))).toBe(false);
  });

  it("reports a notice when an env var shadows an explicitly stored secret", () => {
    writeConfig(BASE_YAML);
    const store = createFileBackend(path.join(home, ".agentrc", "secrets.json"));
    store.set!("AGENTRC_TEST_TOKEN", "stored-value");
    const resolver = new SecretResolver([
      createEnvBackend({ AGENTRC_TEST_TOKEN: "ambient-env-value" }),
      store,
    ]);
    const report = runEngine(options({ resolver }));
    expect(report.notices).toHaveLength(1);
    expect(report.notices[0]).toMatch(/AGENTRC_TEST_TOKEN.*shadowing.*file store/);
    // The env value (documented precedence) is still what gets written.
    const claude = readJson(path.join(home, ".claude.json")) as {
      mcpServers: { github: { env: Record<string, string> } };
    };
    expect(claude.mcpServers.github.env.GITHUB_TOKEN).toBe("ambient-env-value");
  });

  it("emits no shadow notice when the secret only exists in one backend", () => {
    writeConfig(BASE_YAML);
    const report = runEngine(options());
    expect(report.notices).toEqual([]);
  });

  it("redacts resolved secret values in diff output", () => {
    writeConfig(BASE_YAML);
    const report = runEngine(options({ write: false, wantDiff: true }));
    const diffs = report.files
      .map((f) => f.diff)
      .filter((d): d is string => d !== undefined && d !== "");
    expect(diffs.length).toBeGreaterThan(0);
    const combined = diffs.join("\n");
    expect(combined).not.toContain("resolved-token");
    expect(combined).toContain("${secret:AGENTRC_TEST_TOKEN}");
  });

  it("refs mode writes ${NAME} instead of the secret value", () => {
    writeConfig(BASE_YAML);
    runEngine(options({ refs: true, resolver: new SecretResolver([]) }));
    const claude = readJson(path.join(home, ".claude.json")) as {
      mcpServers: { github: { env: Record<string, string> } };
    };
    expect(claude.mcpServers.github.env.GITHUB_TOKEN).toBe("${AGENTRC_TEST_TOKEN}");
  });

  it("project scope writes project-level files and applies the overlay", () => {
    writeConfig(BASE_YAML);
    write(path.join(work, ".agentrc.yaml"), "mcpServers:\n  docs: null\n  db:\n    command: db-mcp\n");
    const report = runEngine(options({ projectDir: work }));

    const mcp = readJson(path.join(work, ".mcp.json")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(mcp.mcpServers).sort()).toEqual(["db", "github"]);
    const cursor = readJson(path.join(work, ".cursor", "mcp.json")) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(cursor.mcpServers).sort()).toEqual(["db", "github"]);
    expect(fs.existsSync(path.join(work, ".gemini", "settings.json"))).toBe(true);

    // Codex has no project scope: warning, no file.
    expect(report.warnings.some((w) => w.client === "codex" && w.message.includes("project-scope"))).toBe(true);
    // User-scope files were not created by a project sync.
    expect(fs.existsSync(path.join(home, ".claude.json"))).toBe(false);
  });

  it("refuses to sync over an unparseable client config", () => {
    write(path.join(home, ".cursor", "mcp.json"), "{ not json");
    writeConfig(BASE_YAML);
    expect(() => runEngine(options({ clients: ["cursor"] }))).toThrow(/cannot parse existing JSON/);
  });
});
