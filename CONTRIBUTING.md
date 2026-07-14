# Contributing to agentrc

Thanks for helping. agentrc aims to stay small, dependency-light and boring in
the best way: pure local, no cloud, no surprises in people's config files.

Not sure where to start? Pick a
[good first issue](https://github.com/JaydenCJ/agentrc/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
or open a [discussion](https://github.com/JaydenCJ/agentrc/discussions) — the
most valuable kind of contribution is a new client adapter (see below).

## Development setup

Requirements: Node.js >= 20.

```console
$ git clone https://github.com/JaydenCJ/agentrc && cd agentrc
$ npm install
$ npm run build        # tsc -> dist/
$ npm test             # vitest
$ ./examples/demo.sh   # end-to-end demo in a sandbox $HOME
```

Useful during development:

```console
$ npm run test:watch   # vitest in watch mode
$ npm run typecheck    # tsc --noEmit
$ node dist/index.js --home /tmp/agentrc-play doctor   # never touch your real configs
```

## Project layout

```
src/
  types.ts          manifest schema types
  cli.ts            command dispatch + help
  cli/              arg parsing, CLI context, report printing
  commands/         init / sync / status / diff / import / secret / doctor
  core/             manifest loader, merge, secrets, engine, state, diff, fs
  adapters/         one file per client (claude-code, codex, cursor, gemini)
test/               vitest suites + fixtures
examples/           demo manifest, presets, skills, demo.sh
```

## Adding a new client adapter

This is the most valuable kind of contribution. An adapter is one file that
implements the `Adapter` interface (`src/adapters/types.ts`):

1. Declare an honest `capabilities` matrix (what the client really supports).
2. Implement `plan()` — convert the manifest into file plans (pure data, no
   I/O). Emit a warning string for anything the client cannot represent;
   never silently drop configuration.
3. Implement `importConfig()` — the reverse conversion.
4. Register it in `src/adapters/index.ts` and add the id to `CLIENT_IDS` in
   `src/types.ts`.
5. Add rendering tests in `test/adapters.test.ts` and an import fixture under
   `test/fixtures/`.

## Ground rules for changes

- **Never touch what we did not write.** The engine only manages entries
  recorded in the state file. Any change that could clobber a user's
  hand-written config needs a test proving it does not.
- **Fail before writing.** Validation and secret resolution run before the
  first byte is written.
- **Deterministic output.** Entries are sorted; two syncs from the same
  manifest must produce identical files.
- **Tests are required.** Bug fixes need a regression test; features need
  coverage for both the happy path and at least one edge case.
- Keep dependencies minimal (currently: `yaml`, `smol-toml`).

## Commit / PR conventions

- One logical change per PR, with a clear description of the observable
  behavior change.
- Run `npm run build && npm test` before pushing — CI runs exactly that.
- For user-visible changes, add an entry under "Unreleased" in
  `CHANGELOG.md`.

## Reporting bugs

Please include: your OS, `agentrc --version`, the manifest (redact secrets —
they should not be in there anyway), the full command output, and if
relevant the target client config before/after. `agentrc doctor` output helps
a lot.
