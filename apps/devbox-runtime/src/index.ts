#!/usr/bin/env node

import { resolve } from "node:path";

import { Command } from "commander";

import { bootstrapRepository } from "./bootstrap.js";
import { HttpCallbackClient } from "./callbacks.js";
import { RuntimeError, safeErrorMessage } from "./errors.js";
import { readBoundedJson } from "./io.js";
import { NativeAgentRunner, SpawnProcessRunner } from "./processes.js";
import {
  BootstrapInputSchema,
  CallbackUrlSchema,
  SessionIdArgumentSchema,
  SessionStartInputSchema,
} from "./schemas.js";
import { attachSession, startSession } from "./sessions/manager.js";
import { inspectSession } from "./sessions/state.js";
import { superviseSession } from "./sessions/supervisor.js";
import { NativeTmuxClient } from "./sessions/tmux.js";

import type { CallbackClient } from "./callbacks.js";
import type { AgentRunner, ProcessRunner } from "./processes.js";
import type { TmuxClient } from "./sessions/tmux.js";

export interface RuntimeDependencies {
  readonly agent: AgentRunner;
  readonly callbacks: CallbackClient;
  readonly gitExecutable: string;
  readonly processes: ProcessRunner;
  readonly repositoryPath: string;
  readonly runtimeExecutable: string;
  readonly sessionsRoot: string;
  readonly tmux: TmuxClient;
}

export function createDefaultDependencies(): RuntimeDependencies {
  const processes = new SpawnProcessRunner();
  const repositoryPath = "/workspace/repo";
  return {
    agent: new NativeAgentRunner({
      executable: "codex",
      workingDirectory: repositoryPath,
    }),
    callbacks: new HttpCallbackClient(),
    gitExecutable: "git",
    processes,
    repositoryPath,
    runtimeExecutable: resolve(process.argv[1] ?? "/usr/local/bin/sfkm-devbox-runtime"),
    sessionsRoot: "/var/lib/sfkm/sessions",
    tmux: new NativeTmuxClient(processes),
  };
}

export function createProgram(dependencies: RuntimeDependencies): Command {
  const program = new Command()
    .name("sfkm-devbox-runtime")
    .description("Mini Starfolk helper for EC2 devboxes")
    .version("0.0.0");

  program.command("bootstrap").action(async () => {
    const input = await readBoundedJson(process.stdin, 64 * 1024, BootstrapInputSchema);
    const result = await bootstrapRepository(input, {
      callbacks: dependencies.callbacks,
      gitExecutable: dependencies.gitExecutable,
      processes: dependencies.processes,
      repositoryPath: dependencies.repositoryPath,
    });
    writeStatus(result);
  });

  const session = program.command("session").description("Manage one native agent session");

  session
    .command("start")
    .argument("<session-id>")
    .requiredOption("--callback-url <url>")
    .action(async (sessionIdValue: string, options: { callbackUrl: string }) => {
      const sessionId = parseSessionId(sessionIdValue);
      const callbackUrl = parseCallbackUrl(options.callbackUrl);
      const input = await readBoundedJson(
        process.stdin,
        300 * 1024,
        SessionStartInputSchema,
      );
      const result = await startSession(sessionId, callbackUrl, input, dependencies);
      writeStatus(result);
    });

  session
    .command("inspect")
    .argument("<session-id>")
    .action(async (sessionIdValue: string) => {
      const result = await inspectSession(parseSessionId(sessionIdValue), dependencies);
      writeStatus(result);
    });

  session
    .command("attach")
    .argument("<session-id>")
    .action(async (sessionIdValue: string) => {
      const result = await attachSession(parseSessionId(sessionIdValue), dependencies);
      writeStatus(result);
    });

  program
    .command("supervise", { hidden: true })
    .argument("<session-id>")
    .action(async (sessionIdValue: string) => {
      const result = await superviseSession(parseSessionId(sessionIdValue), dependencies);
      writeStatus(result);
      if (result.status === "FAILED") {
        process.exitCode = 1;
      }
    });

  return program;
}

async function main(): Promise<void> {
  try {
    await createProgram(createDefaultDependencies()).parseAsync(process.argv);
  } catch (error: unknown) {
    process.stderr.write(`${safeErrorMessage(error)}\n`);
    process.exitCode = error instanceof RuntimeError ? error.exitCode : 1;
  }
}

function parseSessionId(value: string): string {
  const parsed = SessionIdArgumentSchema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeError("INVALID_SESSION_ID", "The session ID is invalid.");
  }
  return parsed.data.toLowerCase();
}

function parseCallbackUrl(value: string): string {
  const parsed = CallbackUrlSchema.safeParse(value);
  if (!parsed.success) {
    throw new RuntimeError("INVALID_CALLBACK_URL", "The callback URL is invalid.");
  }
  return parsed.data;
}

function writeStatus(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

void main();
