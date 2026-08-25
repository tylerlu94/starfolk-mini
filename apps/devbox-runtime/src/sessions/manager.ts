import { chmod, mkdir, rm } from "node:fs/promises";

import { RuntimeError } from "../errors.js";
import { writePrivateFile, writePrivateJsonAtomically } from "../io.js";
import { CallbackUrlSchema, SessionIdArgumentSchema } from "../schemas.js";
import { deterministicTmuxName } from "./naming.js";
import { sessionPaths } from "./paths.js";
import { inspectSession } from "./state.js";

import type { CallbackClient } from "../callbacks.js";
import type { SessionStartInput, StoredSession } from "../schemas.js";
import type { SessionInspection } from "./state.js";
import type { TmuxClient } from "./tmux.js";

export interface SessionManagerOptions {
  readonly callbacks: CallbackClient;
  readonly now?: () => Date;
  readonly repositoryPath: string;
  readonly runtimeExecutable: string;
  readonly sessionsRoot: string;
  readonly tmux: TmuxClient;
}

export async function startSession(
  sessionIdValue: string,
  callbackUrlValue: string,
  input: SessionStartInput,
  options: SessionManagerOptions,
): Promise<SessionInspection> {
  const sessionId = SessionIdArgumentSchema.parse(sessionIdValue).toLowerCase();
  const callbackUrl = CallbackUrlSchema.parse(callbackUrlValue);
  const tmuxName = deterministicTmuxName(sessionId);
  const paths = sessionPaths(options.sessionsRoot, sessionId);
  const inspect = () =>
    inspectSession(sessionId, {
      sessionsRoot: options.sessionsRoot,
      tmux: options.tmux,
    });

  if (await options.tmux.exists(tmuxName)) {
    return await inspect();
  }

  await mkdir(options.sessionsRoot, { mode: 0o700, recursive: true });
  await chmod(options.sessionsRoot, 0o700);
  try {
    await mkdir(paths.directory, { mode: 0o700 });
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "EEXIST") {
      return await inspect();
    }
    throw error;
  }
  await chmod(paths.directory, 0o700);

  const now = options.now ?? (() => new Date());
  const occurredAt = now().toISOString();
  const state: StoredSession = {
    callbackUrl,
    createdAt: occurredAt,
    exitCode: null,
    failureReason: null,
    pid: null,
    sessionId,
    status: "STARTING",
    tmuxName,
    updatedAt: occurredAt,
    version: 1,
  };

  await writePrivateFile(paths.callbackToken, input.callbackToken);
  await writePrivateFile(paths.prompt, input.prompt);
  await writePrivateJsonAtomically(paths.state, state);

  try {
    await options.tmux.start(
      tmuxName,
      options.repositoryPath,
      options.runtimeExecutable,
      ["supervise", sessionId],
    );
  } catch {
    const failedAt = now().toISOString();
    await writePrivateJsonAtomically(paths.state, {
      ...state,
      failureReason: "The tmux supervisor could not be started.",
      status: "FAILED",
      updatedAt: failedAt,
    } satisfies StoredSession);
    await rm(paths.prompt, { force: true });
    await options.callbacks.postSessionStatus(callbackUrl, input.callbackToken, {
      exitCode: null,
      occurredAt: failedAt,
      reason: "The tmux supervisor could not be started.",
      status: "FAILED",
    });
    await rm(paths.callbackToken, { force: true });
    throw new RuntimeError("TMUX_START_FAILED", "Unable to start the session supervisor.");
  }

  return await inspect();
}

export async function attachSession(
  sessionIdValue: string,
  options: Pick<SessionManagerOptions, "sessionsRoot" | "tmux">,
): Promise<SessionInspection> {
  const sessionId = SessionIdArgumentSchema.parse(sessionIdValue).toLowerCase();
  const inspection = await inspectSession(sessionId, options);
  if (inspection.status === "MISSING") {
    throw new RuntimeError("SESSION_NOT_FOUND", "The local session does not exist.");
  }
  if (
    !inspection.tmuxExists ||
    (inspection.status !== "STARTING" && inspection.status !== "RUNNING")
  ) {
    throw new RuntimeError(
      "SESSION_NOT_RECOVERABLE",
      "The original tmux session is no longer attachable.",
    );
  }

  const exitCode = await options.tmux.attach(inspection.tmuxName);
  if (exitCode !== 0) {
    throw new RuntimeError(
      "SESSION_NOT_RECOVERABLE",
      "tmux could not attach to the original session.",
    );
  }
  return await inspectSession(sessionId, options);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
