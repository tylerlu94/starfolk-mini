import { writeFile } from "node:fs/promises";

import type {
  AuthorizeSshKeyResponse,
  CreateDevboxRequest,
  CreateSessionResponse,
  Devbox,
  Session,
} from "@sfkm/contracts";
import { describe, expect, it } from "vitest";

import { CliService, type CliApi, type CliOutput } from "./cli-service.js";
import type {
  ProcessResult,
  ProcessRunner,
  RunProcessOptions,
} from "./process-runner.js";
import type { SignalController } from "./ssh/identity.js";

const devboxId = "devbox_2f1c9de0-f296-4e5d-9aaa-92d945e94ea2";
const sessionId = "session_2f1c9de0-f296-4e5d-9aaa-92d945e94ea2";
const environmentId = "env_2f1c9de0-f296-4e5d-9aaa-92d945e94ea2";
const sha = "1234567890abcdef1234567890abcdef12345678";
const now = "2026-08-23T12:00:00.000Z";
const callbackToken = "callback-token-that-must-only-be-in-stdin";
const prompt = "Fix the tests; do not leak this prompt.";
const publicKey = `ssh-ed25519 ${"A".repeat(80)}`;

describe("CliService devbox commands", () => {
  it("resolves the requested branch, creates, polls to READY, and prints the logical ID", async () => {
    const api = new FakeApi();
    api.createdDevbox = devbox("PROVISIONING");
    api.devboxGets.push(devbox("PROVISIONING"), devbox("READY"));
    const runner = new FakeRunner();
    runner.gitResults.push(success(`${sha}\trefs/heads/main\n`));
    const fixture = serviceFixture(api, runner);

    await fixture.service.createDevbox("https://github.com/openai/example", "main");

    expect(api.createKeys).toEqual(["operation-key"]);
    expect(api.createRequests).toEqual([{
      repository: {
        branch: "main",
        commitSha: sha,
        url: "https://github.com/openai/example.git",
      },
    }]);
    expect(fixture.stdout).toEqual([devboxId]);
    expect(fixture.stderr.at(-1)).toBe(`Devbox ${devboxId} is READY.`);
  });

  it("reports terminal bootstrap failure and sanitizes the reason", async () => {
    const api = new FakeApi();
    api.createdDevbox = devbox("PROVISIONING");
    api.devboxGets.push(devbox("FAILED", "bad\ntoken-like detail"));
    const runner = preflightRunner();
    const fixture = serviceFixture(api, runner);

    await expect(
      fixture.service.createDevbox("https://github.com/openai/example.git", "main"),
    ).rejects.toMatchObject({
      code: "BOOTSTRAP_FAILED",
      message: expect.not.stringContaining("\n"),
    });
  });

  it("polls deletion and treats an already deleted devbox as success", async () => {
    const deletingApi = new FakeApi();
    deletingApi.deletedDevbox = devbox("DELETING");
    deletingApi.devboxGets.push(devbox("DELETED"));
    const deleting = serviceFixture(deletingApi, new FakeRunner());
    await deleting.service.deleteDevbox(devboxId);
    expect(deleting.stdout).toEqual([devboxId]);

    const repeatedApi = new FakeApi();
    repeatedApi.deletedDevbox = devbox("DELETED");
    const repeated = serviceFixture(repeatedApi, new FakeRunner());
    await repeated.service.deleteDevbox(devboxId);
    expect(repeatedApi.devboxGetIds).toEqual([]);
  });
});

describe("CliService SSH", () => {
  it("lands ordinary SSH in /workspace/repo without disabling host checks", async () => {
    const api = new FakeApi();
    const runner = new FakeRunner();
    runner.sshResults.push(success());
    const fixture = serviceFixture(api, runner);

    await fixture.service.ssh(devboxId);

    const call = runner.calls.find(({ command }) => command === "ssh");
    expect(call?.args.at(-1)).toBe("cd /workspace/repo && exec $SHELL -l");
    expect(call?.args).toContain("StrictHostKeyChecking=accept-new");
    expect(call?.args).not.toContain("StrictHostKeyChecking=no");
    expect(call?.options.interactive).toBe(true);
  });
});

describe("CliService session start", () => {
  it("uses two SSH authorizations and sends secrets only through start stdin", async () => {
    const api = new FakeApi();
    api.createdSession = createSession();
    const runner = new FakeRunner();
    runner.sshResults.push(success(runtimeResponse("STARTING")), success());
    const fixture = serviceFixture(api, runner);

    await fixture.service.startSession(devboxId, prompt);

    expect(api.authorizeIds).toEqual([devboxId, devboxId]);
    expect(api.sessionCreateKeys).toEqual(["operation-key"]);
    const sshCalls = runner.calls.filter(({ command }) => command === "ssh");
    expect(sshCalls).toHaveLength(2);
    expect(sshCalls[0]?.args.slice(-6)).toEqual([
      "sfkm-devbox-runtime",
      "session",
      "start",
      sessionId,
      "--callback-url",
      "https://api.example.com/v1/internal/sessions/callback",
    ]);
    expect(sshCalls[0]?.options.stdin).toBe(JSON.stringify({ callbackToken, prompt }));
    expect(sshCalls[1]?.args.slice(-4)).toEqual([
      "sfkm-devbox-runtime",
      "session",
      "attach",
      sessionId,
    ]);
    const allArguments = sshCalls.flatMap(({ args }) => args);
    expect(allArguments).not.toContain(prompt);
    expect(allArguments).not.toContain(callbackToken);
    expect(sshCalls[1]?.options.interactive).toBe(true);
    expect(fixture.stderr).toContain(`Attaching to ${sessionId}.`);
    expect(fixture.stderr).toContain("Detach: Ctrl-b, then d");
    expect(fixture.stderr.at(-1)).toBe(`Reconnect: sfkm session connect ${sessionId}`);
  });

  it("prints the terminal result when the agent finishes during attachment", async () => {
    const api = new FakeApi();
    api.createdSession = createSession();
    api.loadedSession = session("SUCCEEDED", 0);
    const runner = new FakeRunner();
    runner.sshResults.push(success(runtimeResponse("STARTING")), success());
    const fixture = serviceFixture(api, runner);

    await fixture.service.startSession(devboxId, prompt);

    expect(fixture.stdout).toContain(`Session ${sessionId}: SUCCEEDED (exit code 0)`);
    expect(fixture.stderr).not.toContain(`Detached from ${sessionId}.`);
  });

  it("rejects malformed runtime JSON without attaching", async () => {
    const api = new FakeApi();
    api.createdSession = createSession();
    const runner = new FakeRunner();
    runner.sshResults.push(
      success(JSON.stringify({ ...runtimeResponseObject("STARTING"), prompt: "hostile" })),
    );
    const fixture = serviceFixture(api, runner);

    await expect(fixture.service.startSession(devboxId, prompt)).rejects.toMatchObject({
      code: "INVALID_RUNTIME_RESPONSE",
    });
    expect(api.authorizeIds).toHaveLength(1);
  });

  it("rejects a valid runtime response for a different session", async () => {
    const api = new FakeApi();
    api.createdSession = createSession();
    const runner = new FakeRunner();
    runner.sshResults.push(
      success(
        JSON.stringify({
          ...runtimeResponseObject("STARTING"),
          sessionId: "session_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
      ),
    );
    const fixture = serviceFixture(api, runner);

    await expect(fixture.service.startSession(devboxId, prompt)).rejects.toMatchObject({
      code: "INVALID_RUNTIME_RESPONSE",
    });
    expect(api.authorizeIds).toHaveLength(1);
  });

  it("does not attach when an idempotent runtime start reports a terminal session", async () => {
    const api = new FakeApi();
    api.createdSession = createSession();
    const runner = new FakeRunner();
    runner.sshResults.push(success(runtimeResponse("SUCCEEDED", 0)));
    const fixture = serviceFixture(api, runner);

    await fixture.service.startSession(devboxId, prompt);

    expect(api.authorizeIds).toHaveLength(1);
    expect(fixture.stdout).toContain(`Session ${sessionId}: SUCCEEDED (exit code 0)`);
    expect(runner.calls.filter(({ command }) => command === "ssh")).toHaveLength(1);
  });

  it("bounds prompts before creating a backend session", async () => {
    const api = new FakeApi();
    const fixture = serviceFixture(api, new FakeRunner());
    await expect(fixture.service.startSession(devboxId, "x".repeat(32 * 1024 + 1))).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    expect(api.sessionCreateKeys).toEqual([]);
  });
});

describe("CliService session reconnect", () => {
  it("attaches to a running session using inspect and a fresh authorization", async () => {
    const api = new FakeApi();
    api.loadedSession = session("RUNNING");
    const runner = new FakeRunner();
    runner.sshResults.push(success(runtimeResponse("RUNNING")), success());
    const fixture = serviceFixture(api, runner);

    await fixture.service.connectSession(sessionId);

    expect(api.authorizeIds).toEqual([devboxId, devboxId]);
    const sshCalls = runner.calls.filter(({ command }) => command === "ssh");
    expect(sshCalls[0]?.args).toContain("inspect");
    expect(sshCalls[1]?.args).toContain("attach");
    expect(sshCalls.flatMap(({ args }) => args)).not.toContain("start");
    expect(fixture.stderr).toContain("Detach: Ctrl-b, then d");
    expect(fixture.stderr.at(-1)).toBe(`Reconnect: sfkm session connect ${sessionId}`);
  });

  it("prints a backend-terminal session without launching SSH", async () => {
    const api = new FakeApi();
    api.loadedSession = session("SUCCEEDED", 0);
    const runner = new FakeRunner();
    const fixture = serviceFixture(api, runner);

    await fixture.service.connectSession(sessionId);

    expect(runner.calls).toEqual([]);
    expect(fixture.stdout).toEqual([`Session ${sessionId}: SUCCEEDED (exit code 0)`]);
  });

  it("prints a runtime-terminal race without starting or attaching", async () => {
    const api = new FakeApi();
    api.loadedSession = session("RUNNING");
    const runner = new FakeRunner();
    runner.sshResults.push(success(runtimeResponse("FAILED", 2)));
    const fixture = serviceFixture(api, runner);

    await fixture.service.connectSession(sessionId);

    expect(api.authorizeIds).toHaveLength(1);
    expect(fixture.stdout).toEqual([`Session ${sessionId}: FAILED (exit code 2)`]);
  });

  it.each(["MISSING", "UNRECOVERABLE"] as const)(
    "returns SESSION_NOT_RECOVERABLE for runtime %s",
    async (status) => {
      const api = new FakeApi();
      api.loadedSession = session("RUNNING");
      const runner = new FakeRunner();
      runner.sshResults.push(success(runtimeResponse(status)));
      const fixture = serviceFixture(api, runner);

      await expect(fixture.service.connectSession(sessionId)).rejects.toMatchObject({
        code: "SESSION_NOT_RECOVERABLE",
      });
      expect(api.authorizeIds).toHaveLength(1);
      expect(runner.calls.flatMap(({ args }) => args)).not.toContain("start");
    },
  );
});

function serviceFixture(api: FakeApi, runner: FakeRunner) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const output: CliOutput = { stderr: (line) => stderr.push(line), stdout: (line) => stdout.push(line) };
  const signals = new NoopSignals();
  const service = new CliService(api, runner, {
    identity: { signalController: signals },
    output,
    pollAttempts: 5,
    pollDelay: async () => undefined,
    randomId: () => "operation-key",
  });
  return { service, stderr, stdout };
}

class FakeApi implements CliApi {
  readonly authorizeIds: string[] = [];
  readonly createKeys: string[] = [];
  readonly createRequests: CreateDevboxRequest[] = [];
  readonly devboxGetIds: string[] = [];
  readonly devboxGets: Devbox[] = [];
  readonly sessionCreateKeys: string[] = [];
  createdDevbox: Devbox = devbox("PROVISIONING");
  createdSession: CreateSessionResponse = createSession();
  deletedDevbox: Devbox = devbox("DELETED");
  loadedSession: Session = session("RUNNING");

  async authorizeSsh(id: string): Promise<AuthorizeSshKeyResponse> {
    this.authorizeIds.push(id);
    return { host: "ec2.example.com", port: 22, username: "ec2-user" };
  }

  async createDevbox(
    request: CreateDevboxRequest,
    idempotencyKey: string,
  ): Promise<Devbox> {
    this.createRequests.push(request);
    this.createKeys.push(idempotencyKey);
    return this.createdDevbox;
  }

  async createSession(_devboxId: string, idempotencyKey: string): Promise<CreateSessionResponse> {
    this.sessionCreateKeys.push(idempotencyKey);
    return this.createdSession;
  }

  async deleteDevbox(): Promise<Devbox> {
    return this.deletedDevbox;
  }

  async getDevbox(id: string): Promise<Devbox> {
    this.devboxGetIds.push(id);
    const next = this.devboxGets.shift();
    if (next === undefined) {
      throw new Error("Unexpected getDevbox");
    }
    return next;
  }

  async getSession(): Promise<Session> {
    return this.loadedSession;
  }
}

class FakeRunner implements ProcessRunner {
  readonly calls: Array<{
    args: readonly string[];
    command: string;
    options: RunProcessOptions;
  }> = [];
  readonly gitResults: ProcessResult[] = [];
  readonly sshResults: ProcessResult[] = [];

  async run(
    command: string,
    args: readonly string[],
    options: RunProcessOptions = {},
  ): Promise<ProcessResult> {
    this.calls.push({ args, command, options });
    if (command === "git") {
      const result = this.gitResults.shift();
      if (result === undefined) throw new Error("Unexpected git call");
      return result;
    }
    if (command === "ssh-keygen") {
      const privatePath = args.at(-1);
      if (privatePath === undefined) throw new Error("Missing private key path");
      await writeFile(privatePath, "private", { mode: 0o600 });
      await writeFile(`${privatePath}.pub`, `${publicKey}\n`, { mode: 0o600 });
      return success();
    }
    if (command === "ssh") {
      const result = this.sshResults.shift();
      if (result === undefined) throw new Error("Unexpected SSH call");
      return result;
    }
    throw new Error(`Unexpected command: ${command}`);
  }
}

class NoopSignals implements SignalController {
  add(): void {}
  remove(): void {}
  terminateAfterCleanup(): void {}
}

function preflightRunner(): FakeRunner {
  const runner = new FakeRunner();
  runner.gitResults.push(success(`${sha}\trefs/heads/main\n`));
  return runner;
}

function devbox(
  status: Devbox["status"],
  statusReason: string | null = null,
): Devbox {
  return {
    createdAt: now,
    environmentId,
    id: devboxId,
    publicHostname: status === "READY" ? "ec2.example.com" : null,
    readyAt: status === "READY" ? now : null,
    repository: {
      branch: "main",
      commitSha: sha,
      url: "https://github.com/openai/example.git",
    },
    status,
    statusReason,
    updatedAt: now,
  };
}

function createSession(): CreateSessionResponse {
  return {
    callbackToken,
    callbackUrl: "https://api.example.com/v1/internal/sessions/callback",
    devboxId,
    id: sessionId,
    status: "STARTING",
  };
}

function session(status: Session["status"], exitCode: number | null = null): Session {
  return {
    agent: "pinned-agent",
    createdAt: now,
    devboxId,
    exitCode,
    finishedAt: status === "SUCCEEDED" || status === "FAILED" ? now : null,
    id: sessionId,
    model: "pinned-model",
    startedAt: status === "STARTING" ? null : now,
    status,
    statusReason: null,
    updatedAt: now,
  };
}

function success(stdout = ""): ProcessResult {
  return { exitCode: 0, signal: null, stderr: "", stdout };
}

function runtimeResponse(
  status: "MISSING" | "STARTING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "UNRECOVERABLE",
  exitCode: number | null = null,
): string {
  return JSON.stringify(runtimeResponseObject(status, exitCode));
}

function runtimeResponseObject(
  status: "MISSING" | "STARTING" | "RUNNING" | "SUCCEEDED" | "FAILED" | "UNRECOVERABLE",
  exitCode: number | null = null,
) {
  const live = status === "STARTING" || status === "RUNNING";
  return {
    exitCode,
    pid: status === "RUNNING" ? 4242 : null,
    recoverable: live,
    sessionId,
    status,
    tmuxExists: live,
    tmuxName: "sfkm-2f1c9de0-f296-4e5d-9aaa-92d945e94ea2",
  };
}
