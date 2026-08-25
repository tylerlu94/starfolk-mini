import { spawn } from "node:child_process";
import { lstat, mkdtemp, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const installer = join(packageDirectory, "install.sh");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("CLI installer", () => {
  it("installs a working repository-local command and uninstalls only its symlink", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sfkm-installer-test-"));
    temporaryDirectories.push(directory);
    const installDirectory = join(directory, "bin");
    const configFile = join(directory, "config.json");
    const environment = {
      ...process.env,
      SFKM_CONFIG_FILE: configFile,
      SFKM_INSTALL_DIR: installDirectory,
    };

    const installation = await run("sh", [installer], environment);
    expect(installation.exitCode).toBe(0);
    const command = join(installDirectory, "sfkm");
    expect((await lstat(command)).isSymbolicLink()).toBe(true);
    expect(await readlink(command)).toBe(join(packageDirectory, "bin", "sfkm"));

    const help = await run(command, ["--help"], environment);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain("Mini Starfolk CLI");
    expect(help.stdout).toContain("devbox");
    expect(help.stdout).toContain("session");

    const removal = await run("sh", [installer, "--uninstall"], environment);
    expect(removal.exitCode).toBe(0);
    await expect(lstat(command)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function run(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, [...args], {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", rejectRun);
    child.once("close", (exitCode) => resolveRun({ exitCode, stderr, stdout }));
  });
}
