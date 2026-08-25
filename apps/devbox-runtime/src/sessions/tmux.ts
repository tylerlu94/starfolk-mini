import { spawn } from "node:child_process";

import { RuntimeError } from "../errors.js";

import type { ProcessRunner } from "../processes.js";

export interface TmuxClient {
  attach(name: string): Promise<number>;
  exists(name: string): Promise<boolean>;
  start(
    name: string,
    workingDirectory: string,
    executable: string,
    arguments_: readonly string[],
  ): Promise<void>;
}

export class NativeTmuxClient implements TmuxClient {
  constructor(
    private readonly processes: ProcessRunner,
    private readonly executable = "tmux",
  ) {}

  async exists(name: string): Promise<boolean> {
    const result = await this.processes.run(this.executable, [
      "has-session",
      "-t",
      `=${name}`,
    ]);
    return result.exitCode === 0;
  }

  async start(
    name: string,
    workingDirectory: string,
    executable: string,
    arguments_: readonly string[],
  ): Promise<void> {
    const result = await this.processes.run(
      this.executable,
      [
        "new-session",
        "-d",
        "-s",
        name,
        "-c",
        workingDirectory,
        executable,
        ...arguments_,
      ],
      { stderr: "inherit", stdout: "inherit" },
    );
    if (result.exitCode !== 0) {
      throw new RuntimeError("TMUX_START_FAILED", "Unable to create the tmux session.");
    }
  }

  async attach(name: string): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
      const child = spawn(
        this.executable,
        ["attach-session", "-t", `=${name}`],
        { stdio: "inherit" },
      );
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
  }
}
