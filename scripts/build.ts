// Builds the three published packages into their `dist/`: JavaScript with
// `bun build` and type declarations with `tsc`. Each package also gets a copy
// of the root README and licence, which `bun pm pack` and `bun publish` take
// from the package's own directory.
import { copyFile, rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

interface Package {
  name: string;
  entrypoints: string[];
  target: "browser" | "bun";
}

// In dependency order: tsc reads core's declarations to emit the others'.
const packages: Package[] = [
  {
    name: "core",
    entrypoints: ["src/index.ts", "src/testing/index.ts"],
    // No Bun or Node API in core: a browser Transport is meant to reuse it.
    target: "browser",
  },
  { name: "server", entrypoints: ["src/index.ts"], target: "bun" },
  { name: "client", entrypoints: ["src/index.ts"], target: "bun" },
];

for (const { name, entrypoints, target } of packages) {
  const directory = join(root, "packages", name);
  await rm(join(directory, "dist"), { recursive: true, force: true });

  const result = await Bun.build({
    entrypoints: entrypoints.map((entry) => join(directory, entry)),
    root: join(directory, "src"),
    outdir: join(directory, "dist"),
    target,
    // Shared modules go to a common chunk, so that both of core's entry
    // points share one copy of each class.
    splitting: true,
    // The other ticknet packages are dependencies, imported at run time. The
    // pattern is needed on top of `packages`: the workspace's tsconfig paths
    // would otherwise resolve them to their source and bundle it.
    packages: "external",
    external: ["@ticknet/*"],
  });
  if (!result.success) {
    throw new AggregateError(result.logs, `bun build failed for ${name}`);
  }

  const tsc = Bun.spawnSync(
    [
      join(root, "node_modules/.bin/tsc"),
      "-p",
      join(directory, "tsconfig.build.json"),
    ],
    { stdout: "inherit", stderr: "inherit" },
  );
  if (tsc.exitCode !== 0) throw new Error(`tsc failed for ${name}`);

  for (const file of ["README.md", "LICENSE"]) {
    await copyFile(join(root, file), join(directory, file));
  }
  console.log(`Built @ticknet/${name}`);
}
