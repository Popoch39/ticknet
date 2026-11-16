# 14: Publishable packages

**What to build:** A game developer will be able to install the server and client packages separately and get JavaScript with type declarations, no runtime dependencies, and a README that gets them from install to a first exchanged Message. This ticket takes the three packages to the point where a publish dry run succeeds. The real publish is a human step and is not part of this ticket. See the spec, user stories 55 to 59, "Tooling and release" and "Out of Scope".

**Blocked by:** 05, 11, 12, 13

**Status:** ready-for-agent

- [ ] One command builds each package to JavaScript with `bun build` and emits its type declarations with `tsc`
- [ ] Each package declares its entry points and types so that a consumer imports the built output, and core exposes its testing entry point separately
- [ ] The published contents of each package are limited to built output, declarations, README and licence
- [ ] A fresh project that installs the packed server and client packages can type-check and run a Server and a Client exchanging a Message, without type-checking ticknet's sources
- [ ] The built core package contains no Bun or Node API
- [ ] The packages have no runtime dependency other than each other
- [ ] A root README states what ticknet is and is not, shows install and a minimal Server and Client, explains the three Delivery modes and the Tick, and points to the demo
- [ ] The README states the v1 limits plainly: Bun only, plaintext Datagrams, no browser Client
- [ ] `bun publish --dry-run` succeeds for the three packages
- [ ] Nothing is published to the registry, and the README or a release note reminds the maintainer to check that the package name and scope are available first
