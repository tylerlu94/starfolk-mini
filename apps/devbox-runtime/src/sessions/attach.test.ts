import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { attachSession } from "./manager.js";
import { deterministicTmuxName } from "./naming.js";
import { sessionPaths } from "./paths.js";

import type { StoredSession } from "../schemas.js";
import type { TmuxClient } from "./tmux.js";

const sessionId = "session_ea69d7fd-c987-4990-a0c4-d05d78d53e5c";

class AttachTmux implements TmuxClient {
  existsValue = false;
  attachedName: string | null = null;
  async attach(name: string): Promise<number> {
    this.attachedName = name;
    return 0;
  }
  async exists(): Promise<boolean> {
    return this.existsValue;
  }
  async start(): Promise<void> {
    throw new Error("not used");
  }
}

describe("session attach", () => {
  it("returns a clear error for a missing session", async () => {
    const tmux = new AttachTmux();
    await expect(
      attachSession(sessionId, {
        sessionsRoot: join(process.env.TMPDIR ?? "/tmp", crypto.randomUUID()),
        tmux,
      }),
    ).rejects.toMatchObject({ code: "SESSION_NOT_FOUND" });
  });

  it("attaches to the same deterministic tmux session", async () => {
    const root = join(process.env.TMPDIR ?? "/tmp", `sfkm-attach-${crypto.randomUUID()}`);
    const paths = sessionPaths(root, sessionId);
    await mkdir(paths.directory, { recursive: true });
    const now = new Date().toISOString();
    const state: StoredSession = {
      callbackUrl: "https://api.example.test/status",
      createdAt: now,
      exitCode: null,
      failureReason: null,
      pid: 4242,
      sessionId,
      status: "RUNNING",
      tmuxName: deterministicTmuxName(sessionId),
      updatedAt: now,
      version: 1,
    };
    await writeFile(paths.state, JSON.stringify(state));
    await writeFile(paths.pid, "4242\n");
    const tmux = new AttachTmux();
    tmux.existsValue = true;

    await attachSession(sessionId, { sessionsRoot: root, tmux });
    expect(tmux.attachedName).toBe(deterministicTmuxName(sessionId));
  });

  it("never starts a replacement when terminal state is retained", async () => {
    const root = join(process.env.TMPDIR ?? "/tmp", `sfkm-attach-${crypto.randomUUID()}`);
    const paths = sessionPaths(root, sessionId);
    await mkdir(paths.directory, { recursive: true });
    await writeFile(paths.exitCode, "0\n");
    const tmux = new AttachTmux();
    await expect(attachSession(sessionId, { sessionsRoot: root, tmux })).rejects.toMatchObject({
      code: "SESSION_NOT_RECOVERABLE",
    });
    expect(tmux.attachedName).toBeNull();
  });
});
