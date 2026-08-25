import { readFile, rm } from "node:fs/promises";

import { RuntimeError } from "../errors.js";
import { writePrivateFile, writePrivateJsonAtomically } from "../io.js";
import { SessionIdArgumentSchema } from "../schemas.js";
import { sessionPaths } from "./paths.js";
import { inspectSession, readStoredState } from "./state.js";

import type { AgentRunner, AgentResult } from "../processes.js";
import type { StoredSession } from "../schemas.js";
import type { CallbackClient } from "../callbacks.js";
import type { SessionInspection } from "./state.js";
import type { TmuxClient } from "./tmux.js";

export interface SupervisorOptions {
  readonly agent: AgentRunner;
  readonly callbacks: CallbackClient;
  readonly now?: () => Date;
  readonly sessionsRoot: string;
  readonly tmux: TmuxClient;
}

export async function superviseSession(
  sessionIdValue: string,
  options: SupervisorOptions,
): Promise<SessionInspection> {
  const sessionId = SessionIdArgumentSchema.parse(sessionIdValue).toLowerCase();
  const paths = sessionPaths(options.sessionsRoot, sessionId);
  const state = await readStoredState(paths.state);
  if (state === null) {
    throw new RuntimeError("SESSION_NOT_FOUND", "The session state is missing or invalid.");
  }

  const existingPid = await readPid(paths.pid);
  if (
    state.status === "SUCCEEDED" ||
    state.status === "FAILED" ||
    state.pid !== null ||
    existingPid !== null
  ) {
    return await inspectSession(sessionId, {
      sessionsRoot: options.sessionsRoot,
      tmux: options.tmux,
    });
  }

  const callbackToken = await readFile(paths.callbackToken, "utf8");
  const now = options.now ?? (() => new Date());
  let currentState = state;
  let result: AgentResult;

  try {
    result = await options.agent.run(paths.prompt, async (pid) => {
      const occurredAt = now().toISOString();
      currentState = {
        ...currentState,
        pid,
        status: "RUNNING",
        updatedAt: occurredAt,
      };
      await writePrivateFile(paths.pid, `${pid}\n`);
      await writePrivateJsonAtomically(paths.state, currentState);
      try {
        await options.callbacks.postSessionStatus(state.callbackUrl, callbackToken, {
          occurredAt,
          status: "RUNNING",
        });
      } catch {
        // A fast terminal callback is allowed to advance STARTING directly to a
        // terminal status, so a transient RUNNING callback failure is nonfatal.
      }
    });
  } catch {
    await finishSession(
      currentState,
      callbackToken,
      { exitCode: null, signal: null },
      "The agent process could not be started.",
      paths,
      options,
      now,
    );
    throw new RuntimeError("AGENT_START_FAILED", "The agent process could not be started.");
  }

  const failureReason =
    result.exitCode === 0
      ? null
      : result.signal === null
        ? "The agent process exited with a nonzero status."
        : "The agent process was terminated by a signal.";
  await finishSession(
    currentState,
    callbackToken,
    result,
    failureReason,
    paths,
    options,
    now,
  );

  return await inspectSession(sessionId, {
    sessionsRoot: options.sessionsRoot,
    tmux: options.tmux,
  });
}

async function finishSession(
  state: StoredSession,
  callbackToken: string,
  result: AgentResult,
  failureReason: string | null,
  paths: ReturnType<typeof sessionPaths>,
  options: SupervisorOptions,
  now: () => Date,
): Promise<void> {
  const occurredAt = now().toISOString();
  const succeeded = result.exitCode === 0;
  const terminalState: StoredSession = {
    ...state,
    exitCode: result.exitCode,
    failureReason,
    status: succeeded ? "SUCCEEDED" : "FAILED",
    updatedAt: occurredAt,
  };
  if (result.exitCode !== null) {
    await writePrivateFile(paths.exitCode, `${result.exitCode}\n`, "w");
  }
  await writePrivateJsonAtomically(paths.state, terminalState);
  await rm(paths.prompt, { force: true });

  if (succeeded) {
    await options.callbacks.postSessionStatus(state.callbackUrl, callbackToken, {
      exitCode: 0,
      occurredAt,
      status: "SUCCEEDED",
    });
  } else {
    await options.callbacks.postSessionStatus(state.callbackUrl, callbackToken, {
      exitCode: result.exitCode,
      occurredAt,
      reason: failureReason ?? "The agent process failed.",
      status: "FAILED",
    });
  }
  await rm(paths.callbackToken, { force: true });
}

async function readPid(path: string): Promise<number | null> {
  try {
    const pid = Number.parseInt((await readFile(path, "utf8")).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
