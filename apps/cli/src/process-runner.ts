import { spawn } from "node:child_process";

import { CliError } from "./errors.js";

const DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly stdout: string;
}

export interface RunProcessOptions {
  readonly cwd?: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly interactive?: boolean;
  readonly maxOutputBytes?: number;
  readonly stdin?: string;
}

export interface ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options?: RunProcessOptions,
  ): Promise<ProcessResult>;
}

export class SpawnProcessRunner implements ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    options: RunProcessOptions = {},
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      const interactive = options.interactive ?? false;
      const child = spawn(command, [...args], {
        cwd: options.cwd,
        env:
          options.environment === undefined
            ? process.env
            : { ...process.env, ...options.environment },
        stdio: interactive
          ? "inherit"
          : [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
      let outputBytes = 0;
      let settled = false;

      const collect = (chunks: Buffer[], chunk: Buffer): void => {
        outputBytes += chunk.byteLength;
        if (outputBytes > maxBytes) {
          child.kill("SIGTERM");
          if (!settled) {
            settled = true;
            reject(
              new CliError(
                "PROCESS_OUTPUT_TOO_LARGE",
                `${command} produced more output than SFKM accepts.`,
              ),
            );
          }
          return;
        }
        chunks.push(chunk);
      };

      child.stdout?.on("data", (chunk: Buffer) => collect(stdoutChunks, chunk));
      child.stderr?.on("data", (chunk: Buffer) => collect(stderrChunks, chunk));
      child.stdin?.on("error", (error) => {
        if (!settled) {
          settled = true;
          reject(new CliError("PROCESS_IO_FAILED", `Unable to write input to ${command}.`, { cause: error }));
        }
      });
      child.once("error", (error) => {
        if (!settled) {
          settled = true;
          reject(new CliError("PROCESS_START_FAILED", `Unable to start ${command}.`, { cause: error }));
        }
      });
      child.once("close", (exitCode, signal) => {
        if (!settled) {
          settled = true;
          resolve({
            exitCode,
            signal,
            stderr: Buffer.concat(stderrChunks).toString("utf8"),
            stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          });
        }
      });

      if (!interactive && options.stdin !== undefined) {
        child.stdin?.end(options.stdin, "utf8");
      }
    });
  }
}

export function requireSuccessfulProcess(
  command: string,
  result: ProcessResult,
  code: string,
  message: string,
): ProcessResult {
  if (result.exitCode !== 0) {
    throw new CliError(code, message);
  }
  return result;
}
