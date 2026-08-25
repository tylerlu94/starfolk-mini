import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";

import { RuntimeError } from "./errors.js";

export interface RunProcessOptions {
  readonly cwd?: string;
  readonly stderr?: "inherit" | "pipe";
  readonly stdout?: "inherit" | "pipe";
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

export interface ProcessRunner {
  run(
    executable: string,
    arguments_: readonly string[],
    options?: RunProcessOptions,
  ): Promise<ProcessResult>;
}

export class SpawnProcessRunner implements ProcessRunner {
  async run(
    executable: string,
    arguments_: readonly string[],
    options: RunProcessOptions = {},
  ): Promise<ProcessResult> {
    return await new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(executable, [...arguments_], {
        cwd: options.cwd,
        stdio: [
          "ignore",
          options.stdout === "inherit" ? "inherit" : "pipe",
          options.stderr === "inherit" ? "inherit" : "pipe",
        ],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];

      child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        });
      });
    });
  }
}

export interface AgentResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface AgentRunner {
  run(
    promptPath: string,
    onStarted: (pid: number) => Promise<void>,
  ): Promise<AgentResult>;
}

export interface NativeAgentRunnerOptions {
  readonly executable: string;
  readonly workingDirectory: string;
}

export class NativeAgentRunner implements AgentRunner {
  constructor(private readonly options: NativeAgentRunnerOptions) {}

  async run(
    promptPath: string,
    onStarted: (pid: number) => Promise<void>,
  ): Promise<AgentResult> {
    const child = spawn(
      this.options.executable,
      [
        "exec",
        "--sandbox",
        "workspace-write",
        "-",
      ],
      {
        cwd: this.options.workingDirectory,
        stdio: ["pipe", "inherit", "inherit"],
      },
    );

    const started = new Promise<number>((resolve, reject) => {
      child.once("spawn", () => {
        if (child.pid === undefined) {
          reject(new RuntimeError("AGENT_START_FAILED", "The agent process did not provide a PID."));
          return;
        }
        resolve(child.pid);
      });
      child.once("error", reject);
    });
    const completed = new Promise<AgentResult>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
    });

    const pid = await started;
    try {
      await onStarted(pid);
    } catch (error: unknown) {
      child.kill("SIGTERM");
      await completed.catch(() => undefined);
      throw error;
    }
    if (child.stdin === null) {
      throw new RuntimeError("AGENT_START_FAILED", "The agent standard input stream is unavailable.");
    }

    const promptTransport = pipeline(createReadStream(promptPath), child.stdin);
    const result = await completed;
    try {
      await promptTransport;
    } catch (error: unknown) {
      if (result.exitCode === 0) {
        throw error;
      }
    }
    return result;
  }
}
