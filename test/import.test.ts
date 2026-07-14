import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../src/adapters/claude-code.js";
import { codexAdapter } from "../src/adapters/codex.js";
import { cursorAdapter } from "../src/adapters/cursor.js";
import { geminiAdapter } from "../src/adapters/gemini.js";
import type { AdapterContext } from "../src/adapters/types.js";
import { secretizeFragment, sanitizeSecretName, looksSecret } from "../src/core/secretize.js";
import { makeTmpDir, rmrf } from "./helpers.js";

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));

let home: string;
beforeEach(() => {
  home = makeTmpDir();
});
afterEach(() => {
  rmrf(home);
});

function ctx(): AdapterContext {
  return { home, scope: "user" };
}

function installFixture(rel: string, target: string): void {
  fs.mkdirSync(path.dirname(path.join(home, target)), { recursive: true });
  fs.cpSync(path.join(FIXTURES, rel), path.join(home, target), { recursive: true });
}

describe("import converters (client -> manifest)", () => {
  it("imports Claude Code servers, hooks and permissions", () => {
    installFixture("claude/.claude.json", ".claude.json");
    installFixture("claude/.claude", ".claude");
    const { fragment, sources } = claudeCodeAdapter.importConfig(ctx());
    expect(sources).toHaveLength(2);
    expect(fragment.mcpServers?.github).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_plaintext123" },
    });
    expect(fragment.mcpServers?.docs).toEqual({
      transport: "http",
      url: "https://mcp.example.com/docs",
      headers: { Authorization: "Bearer abc123" },
    });
    expect(fragment.hooks).toEqual({
      preToolUse: [{ matcher: "Bash", command: "./guard.sh", timeout: 10 }],
      sessionStart: [{ command: "./hello.sh" }],
    });
    expect(fragment.permissions).toEqual({
      allow: ["Bash(npm run *)"],
      deny: ["Read(./.env)"],
      defaultMode: "acceptEdits",
    });
  });

  it("imports Codex TOML mcp_servers", () => {
    installFixture("codex/config.toml", ".codex/config.toml");
    const { fragment } = codexAdapter.importConfig(ctx());
    expect(Object.keys(fragment.mcpServers ?? {}).sort()).toEqual(["filesystem", "github"]);
    expect(fragment.mcpServers?.github?.env).toEqual({ GITHUB_TOKEN: "ghp_fromcodex" });
    expect(fragment.mcpServers?.filesystem).toEqual({ transport: "stdio", command: "mcp-filesystem" });
  });

  it("imports Cursor mcp.json, mapping url entries to http", () => {
    installFixture("cursor/mcp.json", ".cursor/mcp.json");
    const { fragment } = cursorAdapter.importConfig(ctx());
    expect(fragment.mcpServers?.linear).toEqual({ transport: "http", url: "https://mcp.linear.app/mcp" });
    expect(fragment.mcpServers?.local?.command).toBe("node");
  });

  it("imports Gemini settings.json, distinguishing httpUrl (http) from url (sse)", () => {
    installFixture("gemini/settings.json", ".gemini/settings.json");
    const { fragment } = geminiAdapter.importConfig(ctx());
    expect(fragment.mcpServers?.docs).toEqual({ transport: "http", url: "https://mcp.example.com/docs" });
    expect(fragment.mcpServers?.events).toEqual({ transport: "sse", url: "https://mcp.example.com/sse" });
    expect(fragment.mcpServers?.local?.transport).toBe("stdio");
  });

  it("returns no sources when the client has no config", () => {
    const { fragment, sources } = cursorAdapter.importConfig(ctx());
    expect(sources).toEqual([]);
    expect(fragment).toEqual({});
  });
});

describe("secretize (plaintext -> ${secret:...})", () => {
  it("detects credential-looking keys", () => {
    expect(looksSecret("GITHUB_PERSONAL_ACCESS_TOKEN")).toBe(true);
    expect(looksSecret("Authorization")).toBe(true);
    expect(looksSecret("API_KEY")).toBe(true);
    expect(looksSecret("LOG_LEVEL")).toBe(false);
    expect(looksSecret("PORT")).toBe(false);
  });

  it("sanitizes names into env-var style", () => {
    expect(sanitizeSecretName("Authorization")).toBe("AUTHORIZATION");
    expect(sanitizeSecretName("api-key")).toBe("API_KEY");
    expect(sanitizeSecretName("1weird")).toBe("_1WEIRD");
  });

  it("replaces env and header credentials with references and extracts values", () => {
    const { fragment, extracted } = secretizeFragment({
      mcpServers: {
        github: { transport: "stdio", command: "npx", env: { GITHUB_TOKEN: "ghp_x", LOG_LEVEL: "debug" } },
        docs: { transport: "http", url: "https://d", headers: { Authorization: "Bearer y" } },
      },
    });
    expect(fragment.mcpServers?.github?.env).toEqual({
      GITHUB_TOKEN: "${secret:GITHUB_TOKEN}",
      LOG_LEVEL: "debug",
    });
    expect(fragment.mcpServers?.docs?.headers).toEqual({ Authorization: "${secret:AUTHORIZATION}" });
    expect(extracted.map((e) => e.name).sort()).toEqual(["AUTHORIZATION", "GITHUB_TOKEN"]);
    expect(extracted.find((e) => e.name === "GITHUB_TOKEN")?.value).toBe("ghp_x");
  });

  it("disambiguates the same key with different values across servers", () => {
    const { fragment, extracted } = secretizeFragment({
      mcpServers: {
        one: { transport: "stdio", command: "a", env: { API_KEY: "v1" } },
        two: { transport: "stdio", command: "b", env: { API_KEY: "v2" } },
      },
    });
    expect(fragment.mcpServers?.one?.env?.API_KEY).toBe("${secret:API_KEY}");
    expect(fragment.mcpServers?.two?.env?.API_KEY).toBe("${secret:TWO_API_KEY}");
    expect(extracted.map((e) => e.name).sort()).toEqual(["API_KEY", "TWO_API_KEY"]);
  });

  it("reuses one reference when the same value appears twice and skips existing references", () => {
    const { fragment, extracted } = secretizeFragment({
      mcpServers: {
        one: { transport: "stdio", command: "a", env: { API_KEY: "same" } },
        two: { transport: "stdio", command: "b", env: { API_KEY: "same", OTHER_TOKEN: "${secret:ALREADY}" } },
      },
    });
    expect(fragment.mcpServers?.one?.env?.API_KEY).toBe("${secret:API_KEY}");
    expect(fragment.mcpServers?.two?.env?.API_KEY).toBe("${secret:API_KEY}");
    expect(fragment.mcpServers?.two?.env?.OTHER_TOKEN).toBe("${secret:ALREADY}");
    expect(extracted).toHaveLength(1);
  });

  it("does not mutate the input fragment", () => {
    const input = {
      mcpServers: { s: { transport: "stdio" as const, command: "x", env: { TOKEN: "plain" } } },
    };
    secretizeFragment(input);
    expect(input.mcpServers.s.env.TOKEN).toBe("plain");
  });
});
