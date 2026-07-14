import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentrcError } from "../src/core/errors.js";
import { loadEffectiveManifest } from "../src/core/manifest.js";
import { makeTmpDir, rmrf, write } from "./helpers.js";

let dir: string;
beforeEach(() => {
  dir = makeTmpDir();
});
afterEach(() => {
  rmrf(dir);
});

function config(content: string, name = "agentrc.yaml"): string {
  const file = path.join(dir, name);
  write(file, content);
  return file;
}

describe("manifest validation", () => {
  it("requires version: 1", () => {
    expect(() => loadEffectiveManifest(config("clients: [codex]\n"))).toThrow(/missing required "version"/);
    expect(() => loadEffectiveManifest(config("version: 2\n"))).toThrow(/unsupported manifest version 2/);
  });

  it("rejects unknown top-level keys", () => {
    expect(() => loadEffectiveManifest(config("version: 1\nmcp: {}\n"))).toThrow(/unknown top-level key "mcp"/);
  });

  it("rejects unknown client ids", () => {
    expect(() => loadEffectiveManifest(config("version: 1\nclients: [vscode]\n"))).toThrow(/unknown client "vscode"/);
  });

  it("rejects a server with neither command nor url", () => {
    expect(() => loadEffectiveManifest(config("version: 1\nmcpServers:\n  broken: {}\n"))).toThrow(
      /needs "command" \(stdio\) or "url"/,
    );
  });

  it("rejects a stdio server that also sets url", () => {
    const yaml = "version: 1\nmcpServers:\n  bad:\n    command: run\n    url: https://x\n";
    expect(() => loadEffectiveManifest(config(yaml))).toThrow(/must not set "url"/);
  });

  it("rejects an http server without a url", () => {
    const yaml = "version: 1\nmcpServers:\n  bad:\n    transport: http\n";
    expect(() => loadEffectiveManifest(config(yaml))).toThrow(/"url" is missing/);
  });

  it("rejects unknown hook events", () => {
    const yaml = "version: 1\nhooks:\n  onSave:\n    - command: x\n";
    expect(() => loadEffectiveManifest(config(yaml))).toThrow(/unknown event "onSave"/);
  });

  it("infers transports: stdio from command, http from url", () => {
    const yaml =
      "version: 1\nmcpServers:\n  local:\n    command: run\n  remote:\n    url: https://example.com/mcp\n";
    const { manifest } = loadEffectiveManifest(config(yaml));
    expect(manifest.mcpServers?.local?.transport).toBe("stdio");
    expect(manifest.mcpServers?.remote?.transport).toBe("http");
  });

  it("reports invalid YAML with the file name", () => {
    expect(() => loadEffectiveManifest(config("version: 1\n  broken: ["))).toThrow(/invalid YAML/);
  });
});

describe("extends (team presets)", () => {
  it("merges presets underneath the root manifest, root wins", () => {
    write(
      path.join(dir, "presets", "team.yaml"),
      "mcpServers:\n  github:\n    command: npx\n    env:\n      LOG: verbose\n  docs:\n    url: https://docs\n",
    );
    const file = config(
      "version: 1\nextends:\n  - ./presets/team.yaml\nmcpServers:\n  github:\n    env:\n      LOG: quiet\n",
    );
    const { manifest, sources } = loadEffectiveManifest(file);
    expect(manifest.mcpServers?.github?.command).toBe("npx");
    expect(manifest.mcpServers?.github?.env?.LOG).toBe("quiet");
    expect(manifest.mcpServers?.docs?.url).toBe("https://docs");
    expect(sources).toHaveLength(2);
  });

  it("supports preset chains and diamond graphs", () => {
    write(path.join(dir, "base.yaml"), "mcpServers:\n  a:\n    command: a\n");
    write(path.join(dir, "left.yaml"), "extends: [./base.yaml]\nmcpServers:\n  b:\n    command: b\n");
    write(path.join(dir, "right.yaml"), "extends: [./base.yaml]\nmcpServers:\n  c:\n    command: c\n");
    const file = config("version: 1\nextends: [./left.yaml, ./right.yaml]\n");
    const { manifest } = loadEffectiveManifest(file);
    expect(Object.keys(manifest.mcpServers ?? {}).sort()).toEqual(["a", "b", "c"]);
  });

  it("detects circular extends", () => {
    write(path.join(dir, "a.yaml"), "extends: [./b.yaml]\n");
    write(path.join(dir, "b.yaml"), "extends: [./a.yaml]\n");
    const file = config("version: 1\nextends: [./a.yaml]\n");
    expect(() => loadEffectiveManifest(file)).toThrow(/circular "extends"/);
  });

  it("fails clearly when a preset file is missing", () => {
    const file = config("version: 1\nextends: [./nope.yaml]\n");
    expect(() => loadEffectiveManifest(file)).toThrow(/config file not found/);
  });
});

describe("project overlays", () => {
  it("merges .agentrc.yaml from the project dir on top, including null deletion", () => {
    const file = config(
      "version: 1\nmcpServers:\n  github:\n    command: npx\n  heavy:\n    command: heavy-server\n",
    );
    const project = path.join(dir, "project");
    write(
      path.join(project, ".agentrc.yaml"),
      "mcpServers:\n  heavy: null\n  local-db:\n    command: db-mcp\n",
    );
    const { manifest } = loadEffectiveManifest(file, project);
    expect(manifest.mcpServers?.heavy).toBeUndefined();
    expect(manifest.mcpServers?.["local-db"]?.command).toBe("db-mcp");
    expect(manifest.mcpServers?.github?.command).toBe("npx");
  });

  it("works without a project overlay file", () => {
    const file = config("version: 1\nmcpServers:\n  github:\n    command: npx\n");
    const project = path.join(dir, "empty-project");
    write(path.join(project, ".keep"), "");
    const { manifest } = loadEffectiveManifest(file, project);
    expect(manifest.mcpServers?.github?.command).toBe("npx");
  });

  it("resolves relative skill paths against the declaring file", () => {
    write(path.join(dir, "presets", "team.yaml"), "skills:\n  review:\n    path: ./skills/review\n");
    const file = config("version: 1\nextends: [./presets/team.yaml]\n");
    const { manifest } = loadEffectiveManifest(file);
    expect(manifest.skills?.review?.path).toBe(path.join(dir, "presets", "skills", "review"));
  });

  it("resolves relative hook commands against the declaring file, like skill paths", () => {
    write(
      path.join(dir, "presets", "team.yaml"),
      "hooks:\n  preToolUse:\n    - matcher: Bash\n      command: ./hooks/guard.sh --strict\n",
    );
    const file = config(
      "version: 1\nextends: [./presets/team.yaml]\nhooks:\n  postToolUse:\n    - command: ./notify.sh\n",
    );
    const { manifest } = loadEffectiveManifest(file);
    // Only the leading "./" path token is rewritten; arguments survive.
    expect(manifest.hooks?.preToolUse?.[0]?.command).toBe(
      `${path.join(dir, "presets", "hooks", "guard.sh")} --strict`,
    );
    expect(manifest.hooks?.postToolUse?.[0]?.command).toBe(path.join(dir, "notify.sh"));
  });

  it("leaves bare and absolute hook commands untouched", () => {
    const file = config(
      "version: 1\nhooks:\n  preToolUse:\n    - command: npm run lint\n    - command: /usr/local/bin/guard\n",
    );
    const { manifest } = loadEffectiveManifest(file);
    expect(manifest.hooks?.preToolUse?.[0]?.command).toBe("npm run lint");
    expect(manifest.hooks?.preToolUse?.[1]?.command).toBe("/usr/local/bin/guard");
  });

  it("throws AgentrcError (not a crash) for a missing config", () => {
    expect(() => loadEffectiveManifest(path.join(dir, "missing.yaml"))).toThrow(AgentrcError);
    expect(() => loadEffectiveManifest(path.join(dir, "missing.yaml"))).toThrow(/agentrc init/);
  });
});
