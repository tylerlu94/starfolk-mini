import { describe, expect, it, vi } from "vitest";

import type { CreateDevboxRequest } from "@sfkm/contracts";

import type { AwsDevboxProvider, LaunchDevboxResult } from "./aws/port.js";
import type { ServerConfig } from "./config.js";
import {
  StorePreconditionError,
  type DevboxRecord,
  type EnvironmentRecord,
  type EnvironmentSeed,
  type NewDevboxRecord,
  type NewSessionRecord,
  type SessionRecord,
  type Store,
} from "./db/types.js";
import { ApiError } from "./errors.js";
import { deriveResourceToken } from "./security.js";
import { BackendService, buildUserData } from "./service.js";

const now = new Date("2026-08-23T16:00:00.000Z");
const environment: EnvironmentRecord = {
  amiId: "ami-test",
  configurationHash: "a".repeat(64),
  defaultAgent: "codex",
  defaultModel: "gpt-test",
  id: "env_11111111-1111-4111-8111-111111111111",
  instanceType: "t3.small",
  rootDiskGb: 24,
  runtimeArtifactSha256: "b".repeat(64),
  runtimeArtifactVersion: "bbbbbbbbbbbb",
  setupCommand: "npm ci",
  version: "aaaaaaaaaaaa",
};
const config: ServerConfig = {
  apiTokenHash: "c".repeat(64),
  awsRegion: "ca-central-1",
  databaseUrl: "postgres://unused",
  environment,
  port: 3000,
  publicBaseUrl: "https://api.example.test",
  resourceTokenKey: "test-resource-key-that-is-at-least-32-bytes",
  securityGroupId: "sg-test",
  sshSourceCidr: "192.0.2.1/32",
  subnetId: "subnet-test",
};
const request: CreateDevboxRequest = {
  repository: {
    branch: "main",
    commitSha: "1".repeat(40),
    url: "https://github.com/example/project.git",
  },
};

describe("buildUserData", () => {
  it("passes only the runtime bootstrap contract through standard input", () => {
    const script = buildUserData({
      agentNpmSpec: "@openai/codex@0.146.0",
      artifactSha256: "b".repeat(64),
      artifactUrl: "https://artifacts.example.test/runtime",
      bootstrapToken: "secret-token",
      callbackUrl: "https://api.example.test/v1/internal/devboxes/devbox_test/status",
      devboxId: "devbox_test",
      repository: request.repository,
      setupCommand: "npm ci",
    });
    const encodedMetadata = script.match(
      /printf '%s' '([^']+)' \| base64 --decode > \/var\/lib\/sfkm\/bootstrap\.json/u,
    )?.[1];
    expect(encodedMetadata).toBeDefined();
    const metadata = JSON.parse(
      Buffer.from(encodedMetadata ?? "", "base64").toString("utf8"),
    ) as Record<string, unknown>;
    expect(metadata).toEqual({
      bootstrapToken: "secret-token",
      callbackUrl: "https://api.example.test/v1/internal/devboxes/devbox_test/status",
      devboxId: "devbox_test",
      repository: request.repository,
      setupCommand: "npm ci",
    });
    expect(metadata).not.toHaveProperty("agentNpmSpec");
    expect(metadata).not.toHaveProperty("artifactUrl");
    expect(script).toContain("dnf install -y gcc-c++ git make tmux nodejs24 nodejs24-npm");
  });
});

function setup() {
  const store = new MemoryStore();
  const launchDevbox = vi.fn<AwsDevboxProvider["launchDevbox"]>(
    async (input): Promise<LaunchDevboxResult> => {
      void input;
      return {
        availabilityZone: "ca-central-1a",
        instanceId: "i-test",
      };
    },
  );
  const terminateDevbox = vi.fn(async () => undefined);
  const authorizeSshKey = vi.fn(async () => undefined);
  const getConnectionDetails = vi.fn(async () => ({
    availabilityZone: "ca-central-1a",
    host: "ec2.example.test",
    instanceId: "i-test",
  }));
  const aws: AwsDevboxProvider = {
    authorizeSshKey,
    getConnectionDetails,
    launchDevbox,
    terminateDevbox,
  };
  return {
    authorizeSshKey,
    getConnectionDetails,
    launchDevbox,
    service: new BackendService(store, aws, config, { clock: () => now }),
    store,
    terminateDevbox,
  };
}

describe("BackendService devboxes", () => {
  it("persists before launch and replays the same request without another instance", async () => {
    const { launchDevbox, service, store } = setup();
    const first = await service.createDevbox(request, "create-1");
    const replay = await service.createDevbox(request, "create-1");

    expect(replay.id).toBe(first.id);
    expect(launchDevbox).toHaveBeenCalledTimes(1);
    expect(store.devboxes.get(first.id)?.awsClientToken).toBeTruthy();
    const launchInput = launchDevbox.mock.calls[0]?.[0];
    expect(launchInput?.userData).not.toContain(request.repository.url);
    expect(launchInput?.userData).toContain(
      "dnf install -y gcc-c++ git make tmux nodejs24 nodejs24-npm",
    );
    expect(launchInput?.userData).toContain(
      "runuser -u ec2-user -- /usr/local/bin/sfkm-devbox-runtime bootstrap < /var/lib/sfkm/bootstrap.json",
    );
    expect(launchInput?.userData).not.toContain("--metadata-file");
    expect(launchInput?.tags).toMatchObject({ Project: "sfkm-demo", SFKMDevboxId: first.id });
  });

  it("rejects reuse of a key for a different repository", async () => {
    const { service } = setup();
    await service.createDevbox(request, "create-1");
    await expect(
      service.createDevbox(
        { repository: { ...request.repository, branch: "other" } },
        "create-1",
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
  });

  it("accepts monotonic bootstrap callbacks and treats later callbacks as no-ops", async () => {
    const { service } = setup();
    const devbox = await service.createDevbox(request, "create-1");
    const token = deriveResourceToken(config.resourceTokenKey, "devbox-bootstrap", devbox.id);
    const ready = await service.updateDevboxStatus(devbox.id, token, {
      occurredAt: now.toISOString(),
      status: "READY",
    });
    const delayed = await service.updateDevboxStatus(devbox.id, undefined, {
      occurredAt: now.toISOString(),
      reason: "late failure",
      status: "FAILED",
    });

    expect(ready.status).toBe("READY");
    expect(delayed.status).toBe("READY");
  });

  it("rejects an invalid resource token while provisioning", async () => {
    const { service } = setup();
    const devbox = await service.createDevbox(request, "create-1");
    await expect(
      service.updateDevboxStatus(devbox.id, "wrong", {
        occurredAt: now.toISOString(),
        status: "READY",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("terminates a launch that resolves after deletion began", async () => {
    const store = new MemoryStore();
    let resolveLaunch: ((value: LaunchDevboxResult) => void) | undefined;
    const launchPromise = new Promise<LaunchDevboxResult>((resolve) => {
      resolveLaunch = resolve;
    });
    const aws: AwsDevboxProvider = {
      authorizeSshKey: vi.fn(async () => undefined),
      getConnectionDetails: vi.fn(async () => ({
        availabilityZone: "ca-central-1a",
        host: "ec2.example.test",
        instanceId: "i-race",
      })),
      launchDevbox: vi.fn(async () => launchPromise),
      terminateDevbox: vi.fn(async () => undefined),
    };
    const service = new BackendService(store, aws, config, { clock: () => now });
    const creating = service.createDevbox(request, "create-race");
    await vi.waitFor(() => expect(store.devboxes.size).toBe(1));
    const id = [...store.devboxes.keys()][0];
    expect(id).toBeDefined();
    await service.deleteDevbox(id ?? "");
    resolveLaunch?.({ availabilityZone: "ca-central-1a", instanceId: "i-race" });
    const result = await creating;

    expect(aws.terminateDevbox).toHaveBeenCalledWith("i-race");
    expect(result.status).toBe("DELETED");
  });

  it("deletes a failed devbox with no instance without launching a replacement", async () => {
    const store = new MemoryStore();
    const launchDevbox = vi.fn<AwsDevboxProvider["launchDevbox"]>(async () => {
      throw new Error("capacity unavailable");
    });
    const terminateDevbox = vi.fn(async () => undefined);
    const service = new BackendService(
      store,
      {
        authorizeSshKey: vi.fn(async () => undefined),
        getConnectionDetails: vi.fn(async () => ({
          availabilityZone: "ca-central-1a",
          host: "ec2.example.test",
          instanceId: "unused",
        })),
        launchDevbox,
        terminateDevbox,
      },
      config,
      { clock: () => now },
    );

    await expect(service.createDevbox(request, "create-failed")).rejects.toMatchObject({
      code: "AWS_CAPACITY_UNAVAILABLE",
    });
    const failed = [...store.devboxes.values()][0];
    expect(failed?.status).toBe("FAILED");
    const deleted = await service.deleteDevbox(failed?.id ?? "");

    expect(deleted.status).toBe("DELETED");
    expect(launchDevbox).toHaveBeenCalledTimes(1);
    expect(terminateDevbox).not.toHaveBeenCalled();
  });

  it("authorizes SSH only for a ready devbox", async () => {
    const { authorizeSshKey, service } = setup();
    const devbox = await service.createDevbox(request, "create-1");
    await expect(
      service.authorizeSsh(devbox.id, { publicKey: `ssh-ed25519 ${"A".repeat(80)}` }),
    ).rejects.toMatchObject({ code: "DEVBOX_NOT_READY" });
    const token = deriveResourceToken(config.resourceTokenKey, "devbox-bootstrap", devbox.id);
    await service.updateDevboxStatus(devbox.id, token, {
      occurredAt: now.toISOString(),
      status: "READY",
    });
    await expect(
      service.authorizeSsh(devbox.id, { publicKey: `ssh-ed25519 ${"A".repeat(80)}` }),
    ).resolves.toEqual({ host: "ec2.example.test", port: 22, username: "ec2-user" });
    expect(authorizeSshKey).toHaveBeenCalledOnce();
  });
});

describe("BackendService sessions", () => {
  it("requires a ready devbox, replays callback credentials, and rejects conflicts", async () => {
    const { service } = setup();
    const devbox = await service.createDevbox(request, "create-1");
    await expect(
      service.createSession({ devboxId: devbox.id }, "session-1"),
    ).rejects.toMatchObject({ code: "DEVBOX_NOT_READY" });
    const bootstrapToken = deriveResourceToken(
      config.resourceTokenKey,
      "devbox-bootstrap",
      devbox.id,
    );
    await service.updateDevboxStatus(devbox.id, bootstrapToken, {
      occurredAt: now.toISOString(),
      status: "READY",
    });
    const first = await service.createSession({ devboxId: devbox.id }, "session-1");
    const replay = await service.createSession({ devboxId: devbox.id }, "session-1");
    expect(replay).toEqual(first);

    const secondSetup = setup();
    const other = await secondSetup.service.createDevbox(request, "create-other");
    const otherToken = deriveResourceToken(config.resourceTokenKey, "devbox-bootstrap", other.id);
    await secondSetup.service.updateDevboxStatus(other.id, otherToken, {
      occurredAt: now.toISOString(),
      status: "READY",
    });
    await expect(
      service.createSession({ devboxId: other.id }, "session-1"),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it("allows fast completion and ignores a delayed RUNNING callback", async () => {
    const { service } = setup();
    const devbox = await service.createDevbox(request, "create-1");
    const bootstrapToken = deriveResourceToken(config.resourceTokenKey, "devbox-bootstrap", devbox.id);
    await service.updateDevboxStatus(devbox.id, bootstrapToken, {
      occurredAt: now.toISOString(),
      status: "READY",
    });
    const created = await service.createSession({ devboxId: devbox.id }, "session-1");
    const succeeded = await service.updateSessionStatus(created.id, created.callbackToken, {
      exitCode: 0,
      occurredAt: now.toISOString(),
      status: "SUCCEEDED",
    });
    const delayed = await service.updateSessionStatus(created.id, undefined, {
      occurredAt: now.toISOString(),
      status: "RUNNING",
    });
    expect(succeeded.status).toBe("SUCCEEDED");
    expect(delayed.status).toBe("SUCCEEDED");
  });

  it("fails active sessions when their devbox is deleted", async () => {
    const { service } = setup();
    const devbox = await service.createDevbox(request, "create-1");
    const bootstrapToken = deriveResourceToken(
      config.resourceTokenKey,
      "devbox-bootstrap",
      devbox.id,
    );
    await service.updateDevboxStatus(devbox.id, bootstrapToken, {
      occurredAt: now.toISOString(),
      status: "READY",
    });
    const created = await service.createSession({ devboxId: devbox.id }, "session-1");
    await service.updateSessionStatus(created.id, created.callbackToken, {
      occurredAt: now.toISOString(),
      status: "RUNNING",
    });

    await service.deleteDevbox(devbox.id);

    await expect(service.getSession(created.id)).resolves.toMatchObject({
      exitCode: null,
      finishedAt: now.toISOString(),
      status: "FAILED",
      statusReason: "Devbox was deleted.",
    });
  });
});

describe("BackendService startup reconciliation", () => {
  it("expires stuck operations and completes interrupted deletion", async () => {
    const { service, store, terminateDevbox } = setup();
    const expiring = await service.createDevbox(request, "create-expiring");
    const expiringRecord = store.devboxes.get(expiring.id);
    if (expiringRecord === undefined) throw new Error("missing test devbox");
    store.devboxes.set(expiring.id, {
      ...expiringRecord,
      bootstrapDeadlineAt: new Date(now.getTime() - 1),
    });

    const deleting = await service.createDevbox(request, "create-deleting");
    const deletingRecord = store.devboxes.get(deleting.id);
    if (deletingRecord === undefined) throw new Error("missing test devbox");
    store.devboxes.set(deleting.id, { ...deletingRecord, status: "DELETING" });

    const report = await service.reconcileStartup();
    expect(report).toEqual({
      expiredDevboxes: 1,
      expiredSessions: 0,
      failedDevboxes: 0,
      reconciledDevboxes: 1,
    });
    expect(store.devboxes.get(expiring.id)?.status).toBe("FAILED");
    expect(store.devboxes.get(deleting.id)?.status).toBe("DELETED");
    expect(terminateDevbox).toHaveBeenCalledWith("i-test");
  });
});

class MemoryStore implements Store {
  readonly devboxes = new Map<string, DevboxRecord>();
  readonly sessions = new Map<string, SessionRecord>();

  async close(): Promise<void> {}
  async isReady(): Promise<boolean> { return true; }
  async expireOverdueDevboxes(deadline: Date): Promise<number> {
    let count = 0;
    for (const record of this.devboxes.values()) {
      if (record.status === "PROVISIONING" && record.bootstrapDeadlineAt < deadline) {
        this.updateDevbox(record.id, {
          bootstrapTokenHash: "",
          status: "FAILED",
          statusReason: "Bootstrap deadline expired.",
        });
        count += 1;
      }
    }
    return count;
  }
  async expireOverdueSessions(deadline: Date): Promise<number> {
    let count = 0;
    for (const record of this.sessions.values()) {
      if (record.status === "STARTING" && record.startDeadlineAt < deadline) {
        this.sessions.set(record.id, {
          ...record,
          callbackTokenHash: "",
          finishedAt: deadline,
          status: "FAILED",
          statusReason: "Session start deadline expired.",
        });
        count += 1;
      }
    }
    return count;
  }
  async listReconcilableDevboxes(): Promise<readonly DevboxRecord[]> {
    return [...this.devboxes.values()].filter(({ status }) =>
      status === "PROVISIONING" || status === "DELETING");
  }
  async seedDefaultEnvironment(input: EnvironmentSeed): Promise<EnvironmentRecord> {
    void input;
    return environment;
  }
  async getDefaultEnvironment(): Promise<EnvironmentRecord> { return environment; }

  async createDevbox(input: NewDevboxRecord) {
    const existing = [...this.devboxes.values()].find(
      ({ idempotencyKey }) => idempotencyKey === input.idempotencyKey,
    );
    if (existing !== undefined) return { inserted: false, record: existing };
    const record: DevboxRecord = {
      ...input,
      awsAvailabilityZone: null,
      awsInstanceId: null,
      createdAt: now,
      deletedAt: null,
      publicHostname: null,
      readyAt: null,
      status: "PROVISIONING",
      statusReason: null,
      updatedAt: now,
    };
    this.devboxes.set(record.id, record);
    return { inserted: true, record };
  }

  async getDevbox(id: string): Promise<DevboxRecord | undefined> { return this.devboxes.get(id); }

  async saveDevboxLaunch(id: string, instanceId: string, availabilityZone: string) {
    return this.updateDevbox(id, { awsAvailabilityZone: availabilityZone, awsInstanceId: instanceId });
  }

  async markDevboxDeleting(id: string) {
    const record = this.devboxes.get(id);
    if (record === undefined) return undefined;
    if (["PROVISIONING", "READY", "FAILED"].includes(record.status)) {
      return this.updateDevbox(id, { bootstrapTokenHash: "", status: "DELETING" });
    }
    return record;
  }

  async markDevboxDeleted(id: string, occurredAt: Date) {
    const deleted = this.updateDevbox(id, { deletedAt: occurredAt, status: "DELETED" });
    for (const [sessionId, session] of this.sessions) {
      if (session.devboxId === id && ["STARTING", "RUNNING"].includes(session.status)) {
        this.sessions.set(sessionId, {
          ...session,
          callbackTokenHash: "",
          exitCode: null,
          finishedAt: occurredAt,
          status: "FAILED",
          statusReason: "Devbox was deleted.",
          updatedAt: now,
        });
      }
    }
    return deleted;
  }

  async setDevboxHostname(id: string, hostname: string): Promise<void> {
    this.updateDevbox(id, { publicHostname: hostname });
  }

  async transitionDevboxBootstrap(
    id: string,
    status: "READY" | "FAILED",
    occurredAt: Date,
    reason: string | null,
  ) {
    const current = this.requiredDevbox(id);
    if (current.status !== "PROVISIONING") return current;
    return this.updateDevbox(id, {
      bootstrapTokenHash: "",
      readyAt: status === "READY" ? occurredAt : null,
      status,
      statusReason: reason,
    });
  }

  async createSession(input: NewSessionRecord) {
    const existing = [...this.sessions.values()].find(
      ({ idempotencyKey }) => idempotencyKey === input.idempotencyKey,
    );
    if (existing !== undefined) return { inserted: false, record: existing };
    const devbox = this.devboxes.get(input.devboxId);
    if (devbox === undefined) throw new StorePreconditionError("DEVBOX_NOT_FOUND");
    if (devbox.status !== "READY") throw new StorePreconditionError("DEVBOX_NOT_READY");
    const record: SessionRecord = {
      ...input,
      createdAt: now,
      exitCode: null,
      finishedAt: null,
      startedAt: null,
      status: "STARTING",
      statusReason: null,
      updatedAt: now,
    };
    this.sessions.set(record.id, record);
    return { inserted: true, record };
  }

  async getSession(id: string): Promise<SessionRecord | undefined> { return this.sessions.get(id); }

  async transitionSession(
    id: string,
    status: "RUNNING" | "SUCCEEDED" | "FAILED",
    occurredAt: Date,
    exitCode: number | null,
    reason: string | null,
  ) {
    const current = this.sessions.get(id);
    if (current === undefined) throw new Error("missing session");
    const allowed = status === "RUNNING"
      ? current.status === "STARTING"
      : current.status === "STARTING" || current.status === "RUNNING";
    if (!allowed) return current;
    const record: SessionRecord = {
      ...current,
      callbackTokenHash: status === "RUNNING" ? current.callbackTokenHash : "",
      exitCode,
      finishedAt: status === "RUNNING" ? null : occurredAt,
      startedAt: status === "RUNNING" ? occurredAt : current.startedAt,
      status,
      statusReason: reason,
    };
    this.sessions.set(id, record);
    return record;
  }

  private requiredDevbox(id: string): DevboxRecord {
    const record = this.devboxes.get(id);
    if (record === undefined) throw new Error("missing devbox");
    return record;
  }

  private updateDevbox(id: string, patch: Partial<DevboxRecord>): DevboxRecord {
    const record = { ...this.requiredDevbox(id), ...patch, updatedAt: now };
    this.devboxes.set(id, record);
    return record;
  }
}
