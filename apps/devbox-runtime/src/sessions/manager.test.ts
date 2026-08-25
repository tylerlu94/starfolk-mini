import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { startSession } from "./manager.js";
import { deterministicTmuxName } from "./naming.js";
import { sessionPaths } from "./paths.js";
import { inspectSession } from "./state.js";

import type { CallbackClient } from "../callbacks.js";
import type { SessionStartInput, StoredSession } from "../schemas.js";
import type { TmuxClient } from "./tmux.js";

const sessionId = "session_ea69d7fd-c987-4990-a0c4-d05d78d53e5c";
const callbackUrl = "https://api.example.test/v1/internal/sessions/id/status";
const callbackToken = "t".repeat(64);
const prompt = "Fix $(touch /tmp/never) and `echo secret`; then verify it.";

class FakeTmux implements TmuxClient {
  readonly sessions = new Set<string>();
  readonly starts: Array<{
    arguments_: readonly string[];
    executable: string;
    name: string;
    workingDirectory: string;
  }> = [];
  attachCount = 0;

  async attach(): Promise<number> {
    this.attachCount += 1;
    return 0;
  }

  async exists(name: string): Promise<boolean> {
    return this.sessions.has(name);
  }

  async start(
    name: string,
    workingDirectory: string,
    executable: string,
    arguments_: readonly string[],
  ): Promise<void> {
    this.starts.push({ arguments_, executable, name, workingDirectory });
    this.sessions.add(name);
  }
}

class RacingTmux extends FakeTmux {
  private existenceChecks = 0;

  override async exists(name: string): Promise<boolean> {
    this.existenceChecks += 1;
    if (this.existenceChecks <= 2) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      return false;
    }
    return await super.exists(name);
  }
}

const noCallbacks: CallbackClient = {
  postDevboxStatus: async () => undefined,
  postSessionStatus: async () => undefined,
};

describe("session start", () => {
  it("uses one deterministic tmux name and private state files", async () => {
    const root = temporaryRoot();
    const repositoryPath = join(root, "repo");
    await mkdir(repositoryPath, { recursive: true });
    const tmux = new FakeTmux();
    const input: SessionStartInput = { callbackToken, prompt };

    const first = await startSession(sessionId, callbackUrl, input, {
      callbacks: noCallbacks,
      repositoryPath,
      runtimeExecutable: "/usr/local/bin/sfkm-devbox-runtime",
      sessionsRoot: join(root, "sessions"),
      tmux,
    });

    const paths = sessionPaths(join(root, "sessions"), sessionId);
    expect(first).toMatchObject({
      sessionId,
      status: "STARTING",
      tmuxExists: true,
      tmuxName: deterministicTmuxName(sessionId),
    });
    expect(tmux.starts).toEqual([
      {
        arguments_: ["supervise", sessionId],
        executable: "/usr/local/bin/sfkm-devbox-runtime",
        name: deterministicTmuxName(sessionId),
        workingDirectory: repositoryPath,
      },
    ]);
    expect(JSON.stringify(tmux.starts)).not.toContain(prompt);
    expect(JSON.stringify(tmux.starts)).not.toContain(callbackToken);
    expect(JSON.stringify(tmux.starts)).not.toContain(callbackUrl);
    expect(await readFile(paths.prompt, "utf8")).toBe(prompt);
    expect(await readFile(paths.callbackToken, "utf8")).toBe(callbackToken);
    expect((await stat(paths.directory)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.prompt)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.callbackToken)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.state)).mode & 0o777).toBe(0o600);

    const duplicate = await startSession(
      sessionId,
      callbackUrl,
      { callbackToken: "x".repeat(64), prompt: "different prompt" },
      {
        callbacks: noCallbacks,
        repositoryPath,
        runtimeExecutable: "/usr/local/bin/sfkm-devbox-runtime",
        sessionsRoot: join(root, "sessions"),
        tmux,
      },
    );
    expect(duplicate.tmuxName).toBe(first.tmuxName);
    expect(tmux.starts).toHaveLength(1);
    expect(await readFile(paths.prompt, "utf8")).toBe(prompt);
    expect(await readFile(paths.callbackToken, "utf8")).toBe(callbackToken);
  });

  it("returns an existing tmux session without creating local state", async () => {
    const tmux = new FakeTmux();
    tmux.sessions.add(deterministicTmuxName(sessionId));
    const root = temporaryRoot();
    const result = await startSession(
      sessionId,
      callbackUrl,
      { callbackToken, prompt },
      {
        callbacks: noCallbacks,
        repositoryPath: join(root, "repo"),
        runtimeExecutable: "/runtime",
        sessionsRoot: join(root, "sessions"),
        tmux,
      },
    );
    expect(result).toMatchObject({ recoverable: true, status: "RUNNING" });
    expect(tmux.starts).toHaveLength(0);
  });

  it("uses the session directory as an exclusive lock for concurrent starts", async () => {
    const root = temporaryRoot();
    const repositoryPath = join(root, "repo");
    await mkdir(repositoryPath, { recursive: true });
    const tmux = new RacingTmux();
    const options = {
      callbacks: noCallbacks,
      repositoryPath,
      runtimeExecutable: "/runtime",
      sessionsRoot: join(root, "sessions"),
      tmux,
    };

    await Promise.all([
      startSession(sessionId, callbackUrl, { callbackToken, prompt }, options),
      startSession(
        sessionId,
        callbackUrl,
        { callbackToken: "x".repeat(64), prompt: "duplicate" },
        options,
      ),
    ]);

    expect(tmux.starts).toHaveLength(1);
    const paths = sessionPaths(options.sessionsRoot, sessionId);
    const retainedPrompt = await readFile(paths.prompt, "utf8");
    const retainedToken = await readFile(paths.callbackToken, "utf8");
    expect([
      { prompt, token: callbackToken },
      { prompt: "duplicate", token: "x".repeat(64) },
    ]).toContainEqual({ prompt: retainedPrompt, token: retainedToken });
  });
});

describe("session inspection", () => {
  it("reports missing, reconnectable, success, failure, and unrecoverable states", async () => {
    const root = temporaryRoot();
    const sessionsRoot = join(root, "sessions");
    const tmux = new FakeTmux();
    expect(await inspectSession(sessionId, { sessionsRoot, tmux })).toMatchObject({
      status: "MISSING",
      tmuxExists: false,
    });

    const paths = sessionPaths(sessionsRoot, sessionId);
    await mkdir(paths.directory, { mode: 0o700, recursive: true });
    await writeState(paths.state, "RUNNING", 4242, null);
    await writeFile(paths.pid, "4242\n", { mode: 0o600 });
    tmux.sessions.add(deterministicTmuxName(sessionId));
    expect(
      await inspectSession(sessionId, {
        processExists: () => true,
        sessionsRoot,
        tmux,
      }),
    ).toMatchObject({ pid: 4242, recoverable: true, status: "RUNNING" });

    tmux.sessions.clear();
    await writeFile(paths.exitCode, "0\n", { mode: 0o600 });
    expect(await inspectSession(sessionId, { sessionsRoot, tmux })).toMatchObject({
      exitCode: 0,
      status: "SUCCEEDED",
    });

    await writeFile(paths.exitCode, "9\n", { mode: 0o600 });
    expect(await inspectSession(sessionId, { sessionsRoot, tmux })).toMatchObject({
      exitCode: 9,
      status: "FAILED",
    });

    await writeFile(paths.exitCode, "not-an-exit-code\n", { mode: 0o600 });
    await writeState(paths.state, "RUNNING", 4242, null);
    expect(
      await inspectSession(sessionId, {
        processExists: () => false,
        sessionsRoot,
        tmux,
      }),
    ).toMatchObject({ recoverable: false, status: "UNRECOVERABLE" });
  });
});

function temporaryRoot(): string {
  return join(process.env.TMPDIR ?? "/tmp", `sfkm-session-${crypto.randomUUID()}`);
}

async function writeState(
  path: string,
  status: StoredSession["status"],
  pid: number | null,
  exitCode: number | null,
): Promise<void> {
  const now = new Date().toISOString();
  const state: StoredSession = {
    callbackUrl,
    createdAt: now,
    exitCode,
    failureReason: status === "FAILED" ? "failed" : null,
    pid,
    sessionId,
    status,
    tmuxName: deterministicTmuxName(sessionId),
    updatedAt: now,
    version: 1,
  };
  await writeFile(path, JSON.stringify(state), { mode: 0o600 });
}
