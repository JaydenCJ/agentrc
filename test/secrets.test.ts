import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentrcError } from "../src/core/errors.js";
import {
  createEnvBackend,
  createFileBackend,
  createKeychainBackend,
  createSecretMasker,
  findSecretRefs,
  parseTemplate,
  renderTemplate,
  resolveDeep,
  SecretResolver,
  type ExecFn,
} from "../src/core/secrets.js";
import { makeTmpDir, rmrf } from "./helpers.js";

describe("parseTemplate", () => {
  it("splits text and secret references", () => {
    expect(parseTemplate("Bearer ${secret:API_TOKEN}!")).toEqual([
      { kind: "text", value: "Bearer " },
      { kind: "ref", name: "API_TOKEN" },
      { kind: "text", value: "!" },
    ]);
  });

  it("supports multiple references in one string", () => {
    const tokens = parseTemplate("${secret:A}:${secret:B}");
    expect(tokens.filter((t) => t.kind === "ref")).toHaveLength(2);
  });

  it("treats $$ as an escaped literal dollar", () => {
    expect(renderTemplate("cost: $$5 and $${secret:X}", () => "nope")).toBe("cost: $5 and ${secret:X}");
  });

  it("rejects malformed secret names", () => {
    expect(() => parseTemplate("${secret:}")).toThrow(AgentrcError);
    expect(() => parseTemplate("${secret:1BAD}")).toThrow(/invalid secret reference/);
  });

  it("leaves plain env-style ${VAR} strings untouched", () => {
    expect(renderTemplate("${HOME}/bin", () => "x")).toBe("${HOME}/bin");
  });
});

describe("findSecretRefs / resolveDeep", () => {
  const tree = {
    mcpServers: {
      github: { env: { TOKEN: "${secret:GH}" }, args: ["--token", "${secret:GH}"] },
      docs: { headers: { Authorization: "Bearer ${secret:DOCS}" } },
    },
  };

  it("collects unique names across nested objects and arrays", () => {
    expect([...findSecretRefs(tree)].sort()).toEqual(["DOCS", "GH"]);
  });

  it("replaces references everywhere while preserving structure", () => {
    const resolved = resolveDeep(tree, (name) => `v-${name}`);
    expect(resolved.mcpServers.github.env.TOKEN).toBe("v-GH");
    expect(resolved.mcpServers.github.args).toEqual(["--token", "v-GH"]);
    expect(resolved.mcpServers.docs.headers.Authorization).toBe("Bearer v-DOCS");
    // original untouched
    expect(tree.mcpServers.github.env.TOKEN).toBe("${secret:GH}");
  });
});

describe("file backend", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTmpDir();
  });
  afterEach(() => {
    rmrf(dir);
  });

  it("round-trips set/get/list/remove", () => {
    const backend = createFileBackend(path.join(dir, "secrets.json"));
    backend.set!("A", "1");
    backend.set!("B", "2");
    expect(backend.get("A")).toBe("1");
    expect(backend.list!()).toEqual(["A", "B"]);
    backend.remove!("A");
    expect(backend.get("A")).toBeUndefined();
  });

  it("writes the store with owner-only permissions (0600)", () => {
    const file = path.join(dir, "secrets.json");
    const backend = createFileBackend(file);
    backend.set!("A", "1");
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("rejects a corrupt store file with a clear error", () => {
    const file = path.join(dir, "secrets.json");
    fs.writeFileSync(file, "not json");
    const backend = createFileBackend(file);
    expect(() => backend.get("A")).toThrow(/invalid JSON/);
  });
});

describe("keychain backend (injected exec)", () => {
  function fakeExec(store: Map<string, string>): ExecFn {
    return (cmd, args, input) => {
      if (cmd === "security") {
        if (args[0] === "find-generic-password") {
          const name = args[args.indexOf("-a") + 1]!;
          const value = store.get(name);
          return value === undefined ? { status: 44, stdout: "" } : { status: 0, stdout: `${value}\n` };
        }
        if (args[0] === "add-generic-password") {
          store.set(args[args.indexOf("-a") + 1]!, args[args.indexOf("-w") + 1]!);
          return { status: 0, stdout: "" };
        }
      }
      if (cmd === "secret-tool") {
        if (args[0] === "lookup") {
          const name = args[args.indexOf("account") + 1]!;
          const value = store.get(name);
          return value === undefined ? { status: 1, stdout: "" } : { status: 0, stdout: value };
        }
        if (args[0] === "store") {
          store.set(args[args.indexOf("account") + 1]!, input ?? "");
          return { status: 0, stdout: "" };
        }
      }
      return { status: 127, stdout: "" };
    };
  }

  it("uses macOS `security` on darwin", () => {
    const store = new Map<string, string>();
    const backend = createKeychainBackend({ platform: "darwin", exec: fakeExec(store), hasCommand: () => true });
    expect(backend.available()).toBe(true);
    backend.set!("TOKEN", "s3cret");
    expect(backend.get("TOKEN")).toBe("s3cret");
    expect(backend.get("MISSING")).toBeUndefined();
  });

  it("uses `secret-tool` on linux and reports unavailability without it", () => {
    const store = new Map<string, string>();
    const withTool = createKeychainBackend({ platform: "linux", exec: fakeExec(store), hasCommand: () => true });
    expect(withTool.available()).toBe(true);
    withTool.set!("TOKEN", "abc");
    expect(withTool.get("TOKEN")).toBe("abc");

    const withoutTool = createKeychainBackend({ platform: "linux", exec: fakeExec(store), hasCommand: () => false });
    expect(withoutTool.available()).toBe(false);
  });
});

describe("SecretResolver", () => {
  it("resolves through the chain: env before file store", () => {
    const dir = makeTmpDir();
    try {
      const fileBackend = createFileBackend(path.join(dir, "secrets.json"));
      fileBackend.set!("SHARED", "from-file");
      fileBackend.set!("ONLY_FILE", "file-value");
      const resolver = new SecretResolver([createEnvBackend({ SHARED: "from-env" }), fileBackend]);
      expect(resolver.lookup("SHARED")).toEqual({ value: "from-env", backend: "env" });
      expect(resolver.lookup("ONLY_FILE")).toEqual({ value: "file-value", backend: "file" });
    } finally {
      rmrf(dir);
    }
  });

  it("reports every missing secret at once, sorted", () => {
    const resolver = new SecretResolver([createEnvBackend({})]);
    const { missing } = resolver.resolveAll(["ZZZ", "AAA"]);
    expect(missing).toEqual(["AAA", "ZZZ"]);
  });

  it("flags env values that shadow an explicitly stored secret", () => {
    const dir = makeTmpDir();
    try {
      const fileBackend = createFileBackend(path.join(dir, "secrets.json"));
      fileBackend.set!("SHARED", "from-file");
      const resolver = new SecretResolver([createEnvBackend({ SHARED: "from-env", ONLY_ENV: "x" }), fileBackend]);
      const { values, shadowed } = resolver.resolveAll(["SHARED", "ONLY_ENV"]);
      expect(values.get("SHARED")).toBe("from-env"); // documented precedence holds
      expect(shadowed).toEqual([{ name: "SHARED", used: "env", over: "file" }]);
    } finally {
      rmrf(dir);
    }
  });
});

describe("createSecretMasker", () => {
  it("replaces raw and JSON-escaped occurrences with the reference form", () => {
    const mask = createSecretMasker(new Map([["TOKEN", 'va"lue']]));
    expect(mask('plain va"lue here')).toBe("plain ${secret:TOKEN} here");
    // JSON serialization escapes the quote; the escaped form is caught too.
    expect(mask('"KEY": "va\\"lue"')).toBe('"KEY": "${secret:TOKEN}"');
  });

  it("masks longer values first and skips empty values", () => {
    const mask = createSecretMasker(
      new Map([
        ["SHORT", "abc"],
        ["LONG", "abcdef"],
        ["EMPTY", ""],
      ]),
    );
    expect(mask("x abcdef y abc z")).toBe("x ${secret:LONG} y ${secret:SHORT} z");
    expect(mask("untouched")).toBe("untouched");
  });
});
