# 01: Workspace scaffold and quality gate

**What to build:** A maintainer clones the repository, installs, and runs one command each for type-check, tests and format across three packages (core, server, client) that can import each other. Nothing in the library works yet; this ticket makes every later ticket land on a green gate. It also records the domain vocabulary and the architectural decisions agreed before the spec, so that later tickets have a glossary to follow. See the spec in this feature directory, sections "Packages", "Tooling and release" and "Further Notes".

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] The directory is a git repository, with dependencies and build output ignored
- [x] A Bun workspace holds three packages under one npm scope: core, server, client, all at the same version
- [x] server and client depend on core through the workspace; core depends on nothing
- [x] TypeScript runs in strict mode; core is configured so that Bun and Node APIs are not available to it at type level
- [x] From the root, `bun check`, `bun test` and `bun fmt --check` each cover the whole workspace and pass
- [x] No package script is named `lint` and no third-party linter is installed, so that the built-in `bun lint` takes over once a Bun release ships it
- [ ] `typescript` is the only development dependency; there are no runtime dependencies
- [x] One trivial test per package proves the test runner and the cross-package imports work
- [x] An MIT licence file is present, with the holder taken from the git user name
- [x] A root glossary records the terms listed in the spec's Further Notes, each defined in one or two sentences with the terms to avoid, and contains no implementation detail
- [x] Five one-paragraph ADRs record: transport-only scope, sans-IO core in its own package, library-owned Tick, plaintext Datagrams in v1, WebTransport for browsers

## Comments

- **Deviation: `@types/bun` is a second development dependency.** On Bun 1.4.4, `bun check` does not ship Bun's type definitions: without `@types/bun`, `bun:test` and the `Bun` global cannot be resolved (the checker itself says to run `bun add -d @types/bun`), so neither the tests nor the future `Bun.udpSocket` adapters could type-check. The alternatives were hand-written declarations for Bun or leaving tests out of the type-check; both are worse. There are still no runtime dependencies. Unchecked above for that reason.
- **npm scope:** `@ticknet/core`, `@ticknet/server`, `@ticknet/client`, all at `0.0.0`, as a placeholder until the scope's availability is checked (ticket 14). Each package's `exports` points at `./src/index.ts` for now; ticket 14 switches them to built output.
- **TypeScript layout:** `tsconfig.base.json` holds the strict options; the root `tsconfig.json` has no files and references four projects, which `bun check` follows like `tsc -b` (no `composite` needed). `packages/core/tsconfig.json` covers `src` only with `"types": []` and `lib: ["ESNext"]`, so `Bun`, `process`, `node:*`, `setTimeout` and `console` are all type errors in core (verified with a throwaway probe file). Core's tests live in `packages/core/test/` under their own project with Bun types; a `*.test.ts` placed in `core/src` fails the check. server and client cover `src` and `test` with Bun types.
- **Trivial tests:** core exports `PROTOCOL_VERSION = 1`, re-exported by server and client; each package's test imports it through its package name. Ticket 02 owns the version byte and may reshape this export.
- **Formatting:** `bun fmt` also covers the Markdown under `.scratch/` and `docs/`; run `bun fmt` after editing a ticket or the spec. `bun fmt` prints `workspaces` in `package.json` on several lines.
- **TypeScript version:** `typescript@7.0.2` (the `tsc` binary for declaration emit in ticket 14). Relative imports are written without an extension (`moduleResolution: "bundler"`, no `allowImportingTsExtensions`) so that ticket 14's declaration emit needs no rewriting.
- **TDD seam:** the ticket names the seam (one test per package through its public entry point); no other seam was introduced.
