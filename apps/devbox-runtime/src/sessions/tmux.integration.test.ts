import { spawnSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SpawnProcessRunner } from "../processes.js";
import { NativeTmuxClient } from "./tmux.js";

const tmuxAvailable = spawnSync("tmux", ["-V"], { stdio: "ignore" }).status === 0;

describe.skipIf(!tmuxAvailable)("local tmux integration", () => {
  it("keeps one detached process alive after the launcher exits", async () => {
    const root = join(process.env.TMPDIR ?? "/tmp", `sfkm-tmux-${crypto.randomUUID()}`);
    await mkdir(root, { recursive: true });
    const executable = join(root, "wait-agent");
    await writeFile(
      executable,
      '#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 30_000);\n',
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    const name = `sfkm-test-${crypto.randomUUID()}`;
    const processes = new SpawnProcessRunner();
    const tmux = new NativeTmuxClient(processes);

    try {
      await tmux.start(name, root, executable, []);
      expect(await tmux.exists(name)).toBe(true);
    } finally {
      await processes.run("tmux", ["kill-session", "-t", `=${name}`]);
    }
  });
});
