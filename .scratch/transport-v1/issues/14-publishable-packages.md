# 14: Publishable packages

**What to build:** A game developer will be able to install the server and client packages separately and get JavaScript with type declarations, no runtime dependencies, and a README that gets them from install to a first exchanged Message. This ticket takes the three packages to the point where a publish dry run succeeds. The real publish is a human step and is not part of this ticket. See the spec, user stories 55 to 59, "Tooling and release" and "Out of Scope".

**Blocked by:** 05, 11, 12, 13

**Status:** resolved

- [x] One command builds each package to JavaScript with `bun build` and emits its type declarations with `tsc`
- [x] Each package declares its entry points and types so that a consumer imports the built output, and core exposes its testing entry point separately
- [x] The published contents of each package are limited to built output, declarations, README and licence
- [x] A fresh project that installs the packed server and client packages can type-check and run a Server and a Client exchanging a Message, without type-checking ticknet's sources
- [x] The built core package contains no Bun or Node API
- [x] The packages have no runtime dependency other than each other
- [x] A root README states what ticknet is and is not, shows install and a minimal Server and Client, explains the three Delivery modes and the Tick, and points to the demo
- [x] The README states the v1 limits plainly: Bun only, plaintext Datagrams, no browser Client
- [x] `bun publish --dry-run` succeeds for the three packages
- [x] Nothing is published to the registry, and the README or a release note reminds the maintainer to check that the package name and scope are available first

## Comments

### Map (for later tickets)

- **Build:** `bun run build` (root script, `scripts/build.ts`) builds core, then server, then client: it empties `dist/`, runs `Bun.build` (core with `target: "browser"` and both entry points with `splitting`, so `index.js` and `testing/index.js` share one chunk and one copy of each class; server and client with `target: "bun"` and `@ticknet/*` kept external), then `tsc -p packages/<name>/tsconfig.build.json` for the declarations, then copies the root `README.md` and `LICENSE` into the package (gitignored there). It takes well under a second. Each package also has `"prepack": "bun ../../scripts/build.ts"`, so `bun pm pack` and `bun publish` always ship a fresh build, even from a clean clone.
- **Manifests:** `exports` give `types` and `default` for `.` (and `./testing` in core) under `dist/`; `files: ["dist"]`; `publishConfig.access: "public"` (a scoped package is private by default on npm); a one-line `description`. No `main`/`module` field: Bun reads `exports`.
- **Workspace resolution from source:** `tsconfig.base.json` maps the four package specifiers (`@ticknet/core`, `@ticknet/core/testing`, `@ticknet/server`, `@ticknet/client`) to their `src` entry points with `paths`. Bun reads tsconfig `paths` at run time (verified, including through `extends`), so `bun test`, `bun check` and the demo (`bun examples/arena/src/server.ts`, no flag) keep running from source with no `dist/` at all, while `exports` point at built output for those who install the packages. `tsconfig.build.json` (extends the package's `tsconfig.json`) clears `paths`, so server's and client's declarations are emitted against core's built declarations, the way a consumer sees them.
- **Tests:** `scripts/release.test.ts` (project `scripts/tsconfig.json`, added to the root references) runs `bun run build`, packs each package with `--ignore-scripts` into a temporary directory and checks: core's built `.js` imports only its own files and names none of `Bun`, `process`, `require`, `Buffer`, `__dirname`; each tarball holds only `package.json`, `README.md`, `LICENSE` and `dist/**/*.js|.d.ts`, plus every file its `exports` name; core exposes exactly `.` and `./testing`; the built server and client import `@ticknet/core` instead of bundling it; the packed `dependencies` name only `@ticknet/*` at the package's own version, with no peer or optional dependencies. It rewrites `packages/*/dist` as a side effect.

### Decisions and assumptions

- **Seams.** Not confirmed interactively (implementer sub-agent). The seam is the release artifacts as a maintainer sees them: the build command's output and `bun pm pack` tarballs. The fresh-consumer check was done by hand (below), since it needs a registry download of `@types/bun` and `typescript`.
- **`tsconfig` `paths` rather than an export condition.** The tooling notes suggested a custom condition (`"ticknet-source": "./src/index.ts"`) passed with `--conditions`; the demo runs with plain `bun`, and `conditions` in `bunfig.toml` and `customConditions` in tsconfig are both ignored by Bun's runtime (the latter checked here), so it would have needed a flag on every `bun` and `bun test`. The `"bun"` condition would have pointed installed copies at an unpublished `src/`. `paths` needs no flag and ships nothing.
- **Trap found:** with those `paths`, `bun build --packages external` still inlined core into server and client (the path mapping wins over "external package"). `external: ["@ticknet/*"]` fixes it, and the release test checks that the built server and client import `@ticknet/core` (checked by mutation: without the pattern, both fail).
- **Built core check.** The type configuration alone does not guarantee "no Bun or Node API": an `import type {} from "bun"` in any core file makes `Bun` a valid global everywhere in core and `bun check` passes (checked here by mutation: `bun check` passed, the release test failed on `Bun`). The release test inspects the bundle instead.
- **The README is the same for the three packages**, copied from the root by the build, rather than three hand-kept copies. Its link to `examples/arena` is relative, so it only works on the repository page.
- **Node built-in in the adapters:** `bun build --target bun` writes `node:net` as `"net"`; both resolve in Bun. Server and client declarations name no Bun type (`bun-adapter.d.ts` mentions Bun only in comments), so a consumer's type-check needs `@types/bun` only for its own use of Bun.
- **Deviation kept from ticket 01:** `@types/bun` is still a second development dependency next to `typescript`.
- **Fresh consumer, by hand** (`scratchpad/consumer/`, outside the repository): packed the three tarballs, `package.json` depending on them as local tarball paths with `overrides` pinning `@ticknet/core` to its tarball (the packed server and client depend on `@ticknet/core@0.0.0`, which would otherwise be looked up on the registry), `@types/bun` and `typescript` as dev dependencies, `skipLibCheck: false`. The README's `messages.ts`, `server.ts` and `client.ts` copied verbatim, plus its Tick snippet. `tsc -p .` and `bun check` passed; the installed packages contain only `dist/*.js`, `dist/*.d.ts`, README, licence and `package.json`, so no ticknet source was checked. `bun server.ts` then `bun client.ts`: the Client printed `You said: hello` and exited 0; the Server logged `127.0.0.1 joined`.
- **Dry runs:** `NPM_CONFIG_TOKEN=dummy bun publish --dry-run` exits 0 in each of `packages/core`, `packages/server` and `packages/client`, and `NPM_CONFIG_TOKEN=dummy bun publish --dry-run --filter '@ticknet/*'` from the root dry-runs core, client, server in that order (`Access: public`) and prints `skipped @ticknet/arena: private`, also from a tree with no `dist/`. Nothing was published.

### Before a real publish (maintainer)

- Check that the `@ticknet` scope and the three names are available on npm (or rename everywhere), and log in (`bunx npm login`).
- Set the version (still `0.0.0`) in the three `package.json` files; `bun publish` rewrites `workspace:*` to that exact version.
- Optionally add `repository`, `homepage` and `keywords` to the manifests, and make the README's demo link absolute once the repository URL is known.
