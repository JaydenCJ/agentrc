import fs from "node:fs";
import { stringify as stringifyYaml } from "yaml";
import { flagBool, flagStr, type Parsed } from "../cli/args.js";
import { buildContext, type CliIO, type GlobalContext } from "../cli/context.js";
import { getAdapter } from "../adapters/index.js";
import type { AdapterContext } from "../adapters/types.js";
import { writeFileAtomic } from "../core/fsio.js";
import { defaultResolver, type BackendId } from "../core/secrets.js";
import { secretizeFragment } from "../core/secretize.js";

/** Shared by `agentrc import <client>` and `agentrc init --from <client>`.
 *  Returns the manifest YAML, or undefined when nothing could be imported. */
export function renderImportedManifest(
  clientId: string,
  ctx: GlobalContext,
  parsed: Parsed,
  io: CliIO,
): string | undefined {
  const adapter = getAdapter(clientId);
  const adapterCtx: AdapterContext = { home: ctx.home, scope: "user" };
  const { fragment: raw, sources } = adapter.importConfig(adapterCtx);
  if (sources.length === 0) {
    io.err(`agentrc: no ${adapter.title} configuration found under ${ctx.home}`);
    return undefined;
  }

  let fragment = raw;
  if (!flagBool(parsed, "no-secretize")) {
    const result = secretizeFragment(raw);
    fragment = result.fragment;
    if (result.extracted.length > 0) {
      const save = flagBool(parsed, "save-secrets");
      if (save) {
        const resolver = defaultResolver(ctx.home);
        const store = flagStr(parsed, "store") as BackendId | undefined;
        const backend = resolver.writableBackend(store);
        if (backend === undefined || backend.set === undefined) {
          io.err(`agentrc: no writable secret backend available${store !== undefined ? ` (requested: ${store})` : ""}`);
          return undefined;
        }
        for (const item of result.extracted) {
          backend.set(item.name, item.value);
          io.err(`stored secret ${item.name} (from ${item.location}) in ${backend.id} store`);
        }
      } else {
        for (const item of result.extracted) {
          io.err(`note: ${item.location} looks like a credential; replaced with \${secret:${item.name}}`);
          io.err(`      store it with: agentrc secret set ${item.name}   (or rerun with --save-secrets)`);
        }
      }
    }
  }

  const manifest = { version: 1, ...fragment };
  const header =
    `# Imported by "agentrc import ${adapter.id}"\n` +
    sources.map((s) => `# source: ${s}\n`).join("");
  return header + stringifyYaml(manifest);
}

export function cmdImport(parsed: Parsed, io: CliIO): number {
  const clientId = parsed.positionals[0];
  if (clientId === undefined) {
    io.err("usage: agentrc import <claude-code|codex|cursor|gemini-cli> [-o file]");
    return 2;
  }
  const ctx = buildContext(parsed);
  const yamlText = renderImportedManifest(clientId, ctx, parsed, io);
  if (yamlText === undefined) return 1;

  const output = flagStr(parsed, "output");
  if (output !== undefined) {
    if (fs.existsSync(output) && !flagBool(parsed, "force")) {
      io.err(`agentrc: ${output} already exists (use --force to overwrite)`);
      return 1;
    }
    writeFileAtomic(output, yamlText);
    io.err(`wrote ${output}`);
  } else {
    io.out(yamlText.trimEnd());
  }
  return 0;
}
