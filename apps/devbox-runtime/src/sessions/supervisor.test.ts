import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { HttpCallbackClient } from "../callbacks.js";
import { NativeAgentRunner } from "../processes.js";
import { startFakeCallbackServer } from "../test-support.js";
import { deterministicTmuxName } from "./naming.js";
import { sessionPaths } from "./paths.js";
import { superviseSession } from "./supervisor.js";

import type { AgentRunner } from "../processes.js";
import type { StoredSession } from "../schemas.js";
import type { FakeCallbackServer } from "../test-support.js";
import type { TmuxClient } from "./tmux.js";

const sessionId = "session_ea69d7fd-c987-4990-a0c4-d05d78d53e5c";
const callbackToken = "s".repeat(64);
const prompt = "Fix the path named '$(touch pwned)' and do not interpolate `anything`.";

class ExistingTmux implements TmuxClient {
  async attach(): Promise<number> {
    return 0;
  }
  async exists(): Promise<boolean> {
    return true;
  }
  async start(): Promise<void> {
    throw new Error("not used");
  }
}

const servers: FakeCallbackServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe("session supervisor", () => {
  it("pipes the prompt to a fake agent and retains PID and success", async () => {
    const server = await startFakeCallbackServer();
    servers.push(server);
    const fixture = await createFixture(server.url, 0);

    const result = await superviseSession(sessionId, {
      agent: fixture.agent,
      callbacks: new HttpCallbackClient(server.fetch),
      sessionsRoot: fixture.sessionsRoot,
      tmux: new ExistingTmux(),
    });

    expect(result).toMatchObject({ exitCode: 0, status: "SUCCEEDED" });
    expect(await readFile(fixture.agentPromptPath, "utf8")).toBe(prompt);
    const arguments_ = JSON.parse(await readFile(fixture.agentArgumentsPath, "utf8")) as unknown;
    expect(arguments_).toEqual([
      "exec",
      "--sandbox",
      "workspace-write",
      "-",
    ]);
    expect(JSON.stringify(arguments_)).not.toContain(prompt);
    expect(JSON.stringify(arguments_)).not.toContain(callbackToken);
    expect(server.requests.map((request) => request.body)).toEqual([
      expect.objectContaining({ status: "RUNNING" }),
      expect.objectContaining({ exitCode: 0, status: "SUCCEEDED" }),
    ]);
    expect(server.requests.every((request) => request.authorization === `Bearer ${callbackToken}`)).toBe(true);
    expect(await readFile(fixture.paths.exitCode, "utf8")).toBe("0\n");
    expect(Number.parseInt(await readFile(fixture.paths.pid, "utf8"), 10)).toBeGreaterThan(0);
    await expect(stat(fixture.paths.prompt)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(fixture.paths.callbackToken)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports and retains a failed agent exit code", async () => {
    const server = await startFakeCallbackServer();
    servers.push(server);
    const fixture = await createFixture(server.url, 7);

    const result = await superviseSession(sessionId, {
      agent: fixture.agent,
      callbacks: new HttpCallbackClient(server.fetch),
      sessionsRoot: fixture.sessionsRoot,
      tmux: new ExistingTmux(),
    });
    expect(result).toMatchObject({ exitCode: 7, status: "FAILED" });
    expect(server.requests.at(-1)?.body).toEqual(
      expect.objectContaining({ exitCode: 7, status: "FAILED" }),
    );
    expect(await readFile(fixture.paths.exitCode, "utf8")).toBe("7\n");
  });

  it("retains the callback token when a terminal callback fails", async () => {
    const server = await startFakeCallbackServer((body) =>
      isStatus(body, "SUCCEEDED") ? 503 : 200,
    );
    servers.push(server);
    const fixture = await createFixture(server.url, 0);

    await expect(
      superviseSession(sessionId, {
        agent: fixture.agent,
        callbacks: new HttpCallbackClient(server.fetch),
        sessionsRoot: fixture.sessionsRoot,
        tmux: new ExistingTmux(),
      }),
    ).rejects.toThrow("callback was rejected");
    expect(await readFile(fixture.paths.callbackToken, "utf8")).toBe(callbackToken);
    const state = JSON.parse(await readFile(fixture.paths.state, "utf8")) as StoredSession;
    expect(state).toMatchObject({ exitCode: 0, status: "SUCCEEDED" });
  });

  it("does not start another agent for an already-finished session", async () => {
    const server = await startFakeCallbackServer();
    servers.push(server);
    const fixture = await createFixture(server.url, 0);
    const finished: StoredSession = {
      ...fixture.state,
      exitCode: 0,
      status: "SUCCEEDED",
      updatedAt: new Date().toISOString(),
    };
    await writeFile(fixture.paths.state, JSON.stringify(finished), { mode: 0o600 });
    await writeFile(fixture.paths.exitCode, "0\n", { mode: 0o600 });
    let launches = 0;
    const agent: AgentRunner = {
      run: async () => {
        launches += 1;
        return { exitCode: 0, signal: null };
      },
    };

    const result = await superviseSession(sessionId, {
      agent,
      callbacks: new HttpCallbackClient(server.fetch),
      sessionsRoot: fixture.sessionsRoot,
      tmux: new ExistingTmux(),
    });
    expect(result.status).toBe("SUCCEEDED");
    expect(launches).toBe(0);
    expect(server.requests).toHaveLength(0);
  });
});

async function createFixture(callbackUrl: string, agentExitCode: number) {
  const root = join(process.env.TMPDIR ?? "/tmp", `sfkm-supervisor-${crypto.randomUUID()}`);
  const sessionsRoot = join(root, "sessions");
  const repositoryPath = join(root, "repo");
  const paths = sessionPaths(sessionsRoot, sessionId);
  await mkdir(paths.directory, { mode: 0o700, recursive: true });
  await mkdir(repositoryPath, { recursive: true });
  const now = new Date().toISOString();
  const state: StoredSession = {
    callbackUrl,
    createdAt: now,
    exitCode: null,
    failureReason: null,
    pid: null,
    sessionId,
    status: "STARTING",
    tmuxName: deterministicTmuxName(sessionId),
    updatedAt: now,
    version: 1,
  };
  await writeFile(paths.state, JSON.stringify(state), { mode: 0o600 });
  await writeFile(paths.prompt, prompt, { mode: 0o600 });
  await writeFile(paths.callbackToken, callbackToken, { mode: 0o600 });

  const agentPromptPath = join(root, "agent-prompt");
  const agentArgumentsPath = join(root, "agent-arguments.json");
  const fakeAgentPath = join(root, "fake-agent");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  fs.writeFileSync(${JSON.stringify(agentPromptPath)}, Buffer.concat(chunks));
  fs.writeFileSync(${JSON.stringify(agentArgumentsPath)}, JSON.stringify(process.argv.slice(2)));
  process.exit(${agentExitCode});
});
`;
  await writeFile(fakeAgentPath, source, { mode: 0o700 });
  await chmod(fakeAgentPath, 0o700);

  return {
    agent: new NativeAgentRunner({
      executable: fakeAgentPath,
      workingDirectory: repositoryPath,
    }),
    agentArgumentsPath,
    agentPromptPath,
    paths,
    sessionsRoot,
    state,
  };
}

function isStatus(value: unknown, status: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    value.status === status
  );
}
