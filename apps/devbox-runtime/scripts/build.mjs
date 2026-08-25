import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceDirectory = resolve(packageDirectory, "../..");
const outputDirectory = resolve(packageDirectory, "dist");
const outputFile = resolve(outputDirectory, "sfkm-devbox-runtime.cjs");

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(outputDirectory, { recursive: true });

await build({
  absWorkingDir: workspaceDirectory,
  bundle: true,
  entryPoints: [resolve(packageDirectory, "src/index.ts")],
  format: "cjs",
  legalComments: "none",
  outfile: outputFile,
  packages: "bundle",
  platform: "node",
  sourcemap: false,
  target: "node24",
});

await chmod(outputFile, 0o755);
