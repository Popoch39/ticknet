import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

// These tests run the release build and look at what it produces, the way a
// maintainer would before publishing. They rewrite every package's `dist/`.

const root = join(import.meta.dir, "..");

function run(command: string[], cwd = root): string {
  const result = Bun.spawnSync(command, { cwd, stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(
      `${command.join(" ")} failed in ${cwd}:\n${result.stderr.toString()}`,
    );
  }
  return result.stdout.toString();
}

/** The paths of the files under a directory, relative to it. */
async function filesUnder(directory: string): Promise<string[]> {
  return (await Array.fromAsync(new Bun.Glob("**/*").scan(directory))).sort();
}

const published = ["core", "server", "client"];

let destination = "";

/** The packed tarball of each published package, by name. */
const tarballs = new Map<string, string>();

function tarballOf(name: string): string {
  const tarball = tarballs.get(name);
  if (tarball === undefined) throw new Error(`${name} was not packed`);
  return tarball;
}

beforeAll(async () => {
  run(["bun", "run", "build"]);
  destination = await mkdtemp(join(tmpdir(), "ticknet-pack-"));
  for (const name of published) {
    // Packing would build again (prepack): once is enough.
    const file = run(
      [
        ...["bun", "pm", "pack", "--quiet", "--ignore-scripts"],
        ...["--destination", destination],
      ],
      join(root, "packages", name),
    ).trim();
    tarballs.set(name, join(destination, basename(file)));
  }
}, 60_000);

afterAll(() => rm(destination, { recursive: true, force: true }));

/** The module specifiers a built JavaScript file imports. */
function importsOf(source: string): string[] {
  return new Bun.Transpiler({ loader: "js" })
    .scanImports(source)
    .map((entry) => entry.path);
}

/** The paths inside a tarball, without npm's leading `package/`. */
function contentsOf(tarball: string): string[] {
  return run(["tar", "-tzf", tarball])
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.replace(/^package\//, ""))
    .sort();
}

test.each(published)(
  "@ticknet/%s publishes only its built output, declarations, README and licence",
  (name) => {
    const extra = contentsOf(tarballOf(name)).filter(
      (path) =>
        !["package.json", "README.md", "LICENSE"].includes(path) &&
        !/^dist\/.+\.(js|d\.ts)$/.test(path),
    );
    expect(extra).toEqual([]);
  },
);

test.each(["server", "client"])(
  "the built %s imports core rather than carrying its own copy",
  async (name) => {
    const source = await Bun.file(
      join(root, "packages", name, "dist/index.js"),
    ).text();
    expect(importsOf(source)).toContain("@ticknet/core");
  },
);

interface Manifest {
  version: string;
  exports: Record<string, { types: string; default: string }>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

function manifestOf(tarball: string): Manifest {
  return JSON.parse(run(["tar", "-xzOf", tarball, "package/package.json"]));
}

test.each(published)(
  "@ticknet/%s ships the files its entry points name, with its README and licence",
  (name) => {
    const tarball = tarballOf(name);
    const named = Object.values(manifestOf(tarball).exports).flatMap(
      (entry) => [entry.types, entry.default],
    );
    expect(named.length).toBeGreaterThan(0);
    expect(contentsOf(tarball)).toEqual(
      expect.arrayContaining([
        "README.md",
        "LICENSE",
        ...named.map((path) => path.replace(/^\.\//, "")),
      ]),
    );
  },
);

test("core exposes its testing entry point apart from its main one", () => {
  const { exports } = manifestOf(tarballOf("core"));
  expect(Object.keys(exports).sort()).toEqual([".", "./testing"]);
});

test.each(published)(
  "@ticknet/%s depends at run time on no package but ticknet's own, at its own version",
  (name) => {
    const manifest = manifestOf(tarballOf(name));
    expect(manifest.peerDependencies).toBeUndefined();
    expect(manifest.optionalDependencies).toBeUndefined();
    for (const [dependency, version] of Object.entries(
      manifest.dependencies ?? {},
    )) {
      expect(dependency).toStartWith("@ticknet/");
      expect(version).toBe(manifest.version);
    }
  },
);

test("the built core imports nothing but its own files, and names no Bun or Node API", async () => {
  const dist = join(root, "packages/core/dist");
  const scripts = (await filesUnder(dist)).filter((file) =>
    file.endsWith(".js"),
  );
  expect(scripts).toContain("index.js");
  expect(scripts).toContain("testing/index.js");

  for (const file of scripts) {
    const source = await Bun.file(join(dist, file)).text();
    expect(
      importsOf(source).filter((path) => !path.startsWith(".")),
      file,
    ).toEqual([]);
    expect(
      source.match(/\b(Bun|process|require|Buffer|__dirname)\b/g),
      file,
    ).toBeNull();
  }
});
