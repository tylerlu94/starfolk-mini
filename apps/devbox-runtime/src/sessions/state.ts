import { readFile, stat } from "node:fs/promises";

import { deterministicTmuxName } from "./naming.js";
import { sessionPaths } from "./paths.js";

import type { TmuxClient } from "./tmux.js";
import type { LocalSessionStatus, StoredSession } from "../schemas.js";

import { StoredSessionSchema } from "../schemas.js";

export interface SessionInspection {
  readonly exitCode: number | null;
  readonly pid: number | null;
  readonly recoverable: boolean;
  readonly sessionId: string;
  readonly status: LocalSessionStatus;
  readonly tmuxExists: boolean;
  readonly tmuxName: string;
}

export interface SessionInspectorOptions {
  readonly processExists?: (pid: number) => boolean;
  readonly sessionsRoot: string;
  readonly tmux: TmuxClient;
}

export async function inspectSession(
  sessionId: string,
  options: SessionInspectorOptions,
): Promise<SessionInspection> {
  const paths = sessionPaths(options.sessionsRoot, sessionId);
  const tmuxName = deterministicTmuxName(sessionId);
  const [directoryExists, tmuxExists] = await Promise.all([
    pathExists(paths.directory),
    options.tmux.exists(tmuxName),
  ]);

  if (!directoryExists) {
    return {
      exitCode: null,
      pid: null,
      recoverable: tmuxExists,
      sessionId: sessionId.toLowerCase(),
      status: tmuxExists ? "RUNNING" : "MISSING",
      tmuxExists,
      tmuxName,
    };
  }

  const [state, pid, exitCode] = await Promise.all([
    readStoredState(paths.state),
    readInteger(paths.pid, true),
    readInteger(paths.exitCode, false),
  ]);

  if (exitCode !== null) {
    return result(
      sessionId,
      tmuxName,
      tmuxExists,
      pid,
      exitCode,
      exitCode === 0 ? "SUCCEEDED" : "FAILED",
      false,
    );
  }

  if (state?.status === "SUCCEEDED" || state?.status === "FAILED") {
    return result(
      sessionId,
      tmuxName,
      tmuxExists,
      state.pid ?? pid,
      state.exitCode,
      state.status,
      false,
    );
  }

  const effectivePid = state?.pid ?? pid;
  const processExists = options.processExists ?? defaultProcessExists;
  const pidIsLive = effectivePid === null ? false : processExists(effectivePid);

  if (tmuxExists) {
    return result(
      sessionId,
      tmuxName,
      true,
      effectivePid,
      null,
      state?.status === "STARTING" && !pidIsLive ? "STARTING" : "RUNNING",
      true,
    );
  }

  if (state?.status === "STARTING" && effectivePid === null) {
    return result(sessionId, tmuxName, false, null, null, "STARTING", false);
  }

  return result(
    sessionId,
    tmuxName,
    false,
    effectivePid,
    null,
    "UNRECOVERABLE",
    false,
  );
}

export async function readStoredState(path: string): Promise<StoredSession | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    const result = StoredSessionSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

function result(
  sessionId: string,
  tmuxName: string,
  tmuxExists: boolean,
  pid: number | null,
  exitCode: number | null,
  status: LocalSessionStatus,
  recoverable: boolean,
): SessionInspection {
  return {
    exitCode,
    pid,
    recoverable,
    sessionId: sessionId.toLowerCase(),
    status,
    tmuxExists,
    tmuxName,
  };
}

async function readInteger(path: string, positive: boolean): Promise<number | null> {
  try {
    const contents = (await readFile(path, "utf8")).trim();
    if (!/^-?\d+$/u.test(contents)) {
      return null;
    }
    const value = Number.parseInt(contents, 10);
    if (!Number.isInteger(value) || (positive && value <= 0)) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function defaultProcessExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return isNodeError(error) && error.code === "EPERM";
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
