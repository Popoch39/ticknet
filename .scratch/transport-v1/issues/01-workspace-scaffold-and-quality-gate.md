# 01: Workspace scaffold and quality gate

**What to build:** A maintainer clones the repository, installs, and runs one command each for type-check, tests and format across three packages (core, server, client) that can import each other. Nothing in the library works yet; this ticket makes every later ticket land on a green gate. It also records the domain vocabulary and the architectural decisions agreed before the spec, so that later tickets have a glossary to follow. See the spec in this feature directory, sections "Packages", "Tooling and release" and "Further Notes".

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] The directory is a git repository, with dependencies and build output ignored
- [ ] A Bun workspace holds three packages under one npm scope: core, server, client, all at the same version
- [ ] server and client depend on core through the workspace; core depends on nothing
- [ ] TypeScript runs in strict mode; core is configured so that Bun and Node APIs are not available to it at type level
- [ ] From the root, `bun check`, `bun test` and `bun fmt --check` each cover the whole workspace and pass
- [ ] No package script is named `lint` and no third-party linter is installed, so that the built-in `bun lint` takes over once a Bun release ships it
- [ ] `typescript` is the only development dependency; there are no runtime dependencies
- [ ] One trivial test per package proves the test runner and the cross-package imports work
- [ ] An MIT licence file is present, with the holder taken from the git user name
- [ ] A root glossary records the terms listed in the spec's Further Notes, each defined in one or two sentences with the terms to avoid, and contains no implementation detail
- [ ] Five one-paragraph ADRs record: transport-only scope, sans-IO core in its own package, library-owned Tick, plaintext Datagrams in v1, WebTransport for browsers
