import path from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { cursorAdapter } from "../src/adapters/cursor.js";
import { geminiAdapter } from "../src/adapters/gemini.js";
import { selectClients } from "../src/adapters/index.js";
import type { AdapterContext } from "../src/adapters/types.js";
import type { Manifest } from "../src/types.js";

const HOME = path.sep + path.join("fake-home");
const userCtx: AdapterContext = { home: HOME, scope: "user" };
const projectDir = path.sep + path.join("repo");
const projectCtx: AdapterContext = { home: HOME, scope: "project", projectDir };

const manifest: Manifest = {
  version: 1,
  mcpServers: {
    github: {
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "tok" },
    },
    docs: { transport: "http", url: "https://mcp.example.com/docs", headers: { Authorization: "Bearer x" } },
    events: { transport: "sse", url: "https://mcp.example.com/sse" },
  },
  hooks: { preToolUse: [{ matcher: "Bash", command: "./guard.sh", timeout: 10 }] },
  permissions: { allow: ["Bash(npm run *)"], deny: ["Read(./.env)"] },
  skills: { review: { path: "/skills/review" } },
};

function entriesOf(adapter: { plan: (m: Manifest, c: AdapterContext) => { files: Array<{ sets: unknown[] }> } }, m: Manifest, ctx: AdapterContext, fileIndex = 0): Record<string, unknown> {
  const plan = adapter.plan(m, ctx);
  const set = plan.files[fileIndex]!.sets[0] as { entries: Record<string, unknown> };
  return set.entries;
}

describe("claude-code adapter", () => {
  it("renders stdio, http and sse servers with explicit types", () => {
    const entries = entriesOf(claudeCodeAdapter, manifest, userCtx);
    expect(entries.github).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "tok" },
    });
    expect(entries.docs).toEqual({
      type: "http",
      url: "https://mcp.example.com/docs",
      headers: { Authorization: "Bearer x" },
    });
    expect(entries.events).toEqual({ type: "sse", url: "https://mcp.example.com/sse" });
  });

  it("translates hook events to Claude Code's PascalCase groups", () => {
    const plan = claudeCodeAdapter.plan(manifest, userCtx);
    const settings = plan.files[1]!;
    const hookSet = settings.sets.find((s) => s.keyPath.join(".") === "hooks");
    expect(hookSet).toBeDefined();
    expect((hookSet as { value: unknown }).value).toEqual({
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./guard.sh", timeout: 10 }] }],
    });
  });

  it("maps permissions onto settings.json and plans skills", () => {
    const plan = claudeCodeAdapter.plan(manifest, userCtx);
    const permSet = plan.files[1]!.sets.find((s) => s.keyPath.join(".") === "permissions");
    expect((permSet as { value: unknown }).value).toEqual({
      allow: ["Bash(npm run *)"],
      deny: ["Read(./.env)"],
    });
    expect(plan.dirs).toEqual([
      { name: "review", source: "/skills/review", target: path.join(HOME, ".claude", "skills", "review") },
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it("uses .mcp.json and .claude/ inside the project for project scope", () => {
    const plan = claudeCodeAdapter.plan(manifest, projectCtx);
    expect(plan.files[0]!.path).toBe(path.join(projectDir, ".mcp.json"));
    expect(plan.files[1]!.path).toBe(path.join(projectDir, ".claude", "settings.json"));
    expect(plan.dirs[0]!.target).toBe(path.join(projectDir, ".claude", "skills", "review"));
  });
});

describe("codex adapter", () => {
  it("renders stdio servers as [mcp_servers.*] TOML entries and skips remote ones with a warning", () => {
    const plan = codexAdapter.plan(manifest, userCtx);
    expect(plan.files[0]!.path).toBe(path.join(HOME, ".codex", "config.toml"));
    expect(plan.files[0]!.format).toBe("toml");
    const set = plan.files[0]!.sets[0] as { keyPath: string[]; entries: Record<string, unknown> };
    expect(set.keyPath).toEqual(["mcp_servers"]);
    expect(Object.keys(set.entries)).toEqual(["github"]);
    expect(plan.warnings.some((w) => w.includes('"docs"') && w.includes("http"))).toBe(true);
    expect(plan.warnings.some((w) => w.includes('"events"') && w.includes("sse"))).toBe(true);
  });

  it("warns that hooks, permissions and skills are unsupported", () => {
    const plan = codexAdapter.plan(manifest, userCtx);
    expect(plan.warnings.some((w) => w.includes("hooks"))).toBe(true);
    expect(plan.warnings.some((w) => w.includes("permission"))).toBe(true);
    expect(plan.warnings.some((w) => w.includes("skills"))).toBe(true);
  });

  it("skips project scope with a warning instead of writing anywhere", () => {
    const plan = codexAdapter.plan(manifest, projectCtx);
    expect(plan.files).toEqual([]);
    expect(plan.warnings.some((w) => w.includes("project-scope"))).toBe(true);
  });
});

describe("cursor adapter", () => {
  it("renders stdio as command entries and remote servers as url entries", () => {
    const entries = entriesOf(cursorAdapter, manifest, userCtx);
    expect(entries.github).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "tok" },
    });
    expect(entries.docs).toEqual({ url: "https://mcp.example.com/docs", headers: { Authorization: "Bearer x" } });
  });

  it("writes .cursor/mcp.json in both scopes", () => {
    expect(cursorAdapter.plan(manifest, userCtx).files[0]!.path).toBe(path.join(HOME, ".cursor", "mcp.json"));
    expect(cursorAdapter.plan(manifest, projectCtx).files[0]!.path).toBe(path.join(projectDir, ".cursor", "mcp.json"));
  });
});

describe("gemini-cli adapter", () => {
  it("uses httpUrl for http servers and url for sse servers", () => {
    const entries = entriesOf(geminiAdapter, manifest, userCtx);
    expect(entries.docs).toEqual({ httpUrl: "https://mcp.example.com/docs", headers: { Authorization: "Bearer x" } });
    expect(entries.events).toEqual({ url: "https://mcp.example.com/sse" });
    expect(entries.github).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "tok" },
    });
  });

  it("targets .gemini/settings.json", () => {
    expect(geminiAdapter.plan(manifest, userCtx).files[0]!.path).toBe(path.join(HOME, ".gemini", "settings.json"));
  });
});

describe("client targeting", () => {
  it("honors per-server clients restrictions", () => {
    const restricted: Manifest = {
      version: 1,
      mcpServers: {
        everywhere: { transport: "stdio", command: "a" },
        "claude-only": { transport: "stdio", command: "b", clients: ["claude-code"] },
      },
    };
    expect(Object.keys(entriesOf(claudeCodeAdapter, restricted, userCtx)).sort()).toEqual([
      "claude-only",
      "everywhere",
    ]);
    expect(Object.keys(entriesOf(codexAdapter, restricted, userCtx))).toEqual(["everywhere"]);
  });

  it("selectClients: explicit flags beat the manifest, manifest beats the default", () => {
    const m: Manifest = { version: 1, clients: ["codex", "cursor"] };
    expect(selectClients(m)).toEqual(["codex", "cursor"]);
    expect(selectClients(m, ["gemini-cli"])).toEqual(["gemini-cli"]);
    expect(selectClients({ version: 1 })).toEqual(["claude-code", "codex", "cursor", "gemini-cli"]);
  });
});
