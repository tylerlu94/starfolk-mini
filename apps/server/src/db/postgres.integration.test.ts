import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "./migrations.js";
import { PostgresStore } from "./postgres.js";
import { StorePreconditionError, type EnvironmentSeed } from "./types.js";

const databaseUrl = process.env.SFKM_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl === undefined ? describe.skip : describe;
const schema = `sfkm_test_${randomUUID().replaceAll("-", "")}`;
let adminPool: Pool;
let store: PostgresStore;

const seed: EnvironmentSeed = {
  amiId: "ami-test",
  configurationHash: "a".repeat(64),
  defaultAgent: "codex",
  defaultModel: "gpt-test",
  instanceType: "t3.small",
  rootDiskGb: 24,
  runtimeArtifactSha256: "b".repeat(64),
  runtimeArtifactVersion: "bbbbbbbbbbbb",
  setupCommand: "npm ci",
  version: "aaaaaaaaaaaa",
};

describeWithPostgres("PostgresStore integration", () => {
  beforeAll(async () => {
    if (databaseUrl === undefined) return;
    adminPool = new Pool({ connectionString: databaseUrl });
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const scopedUrl = new URL(databaseUrl);
    scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
    store = new PostgresStore(scopedUrl.toString());
    await runMigrations(store.pool);
  });

  afterAll(async () => {
    if (databaseUrl === undefined) return;
    await store.close();
    await adminPool.query(`DROP SCHEMA ${schema} CASCADE`);
    await adminPool.end();
  });

  it("applies migrations and seeds one immutable default environment", async () => {
    const first = await store.seedDefaultEnvironment(seed);
    const replay = await store.seedDefaultEnvironment(seed);
    expect(replay).toEqual(first);
    await expect(
      store.seedDefaultEnvironment({ ...seed, configurationHash: "c".repeat(64) }),
    ).rejects.toThrow("does not match");
    await expect(
      store.pool.query("UPDATE environments SET instance_type = 't3.medium' WHERE id = $1", [first.id]),
    ).rejects.toThrow("immutable");
  });

  it("enforces idempotency and transactional ready-devbox session creation", async () => {
    const environment = await store.getDefaultEnvironment();
    const input = {
      awsClientToken: randomUUID(),
      bootstrapDeadlineAt: new Date(Date.now() + 60_000),
      bootstrapTokenHash: "d".repeat(64),
      environmentId: environment.id,
      id: `devbox_${randomUUID()}`,
      idempotencyKey: "database-create-1",
      repository: {
        branch: "main",
        commitSha: "1".repeat(40),
        url: "https://github.com/example/project.git",
      },
      requestHash: "e".repeat(64),
    };
    const created = await store.createDevbox(input);
    const replay = await store.createDevbox({
      ...input,
      awsClientToken: randomUUID(),
      id: `devbox_${randomUUID()}`,
    });
    expect(created.inserted).toBe(true);
    expect(replay).toEqual({ inserted: false, record: created.record });

    const sessionInput = {
      agent: "codex",
      callbackTokenHash: "f".repeat(64),
      devboxId: created.record.id,
      id: `session_${randomUUID()}`,
      idempotencyKey: "database-session-1",
      model: "gpt-test",
      requestHash: "0".repeat(64),
      startDeadlineAt: new Date(Date.now() + 60_000),
      tmuxName: `sfkm-${randomUUID()}`,
    };
    await expect(store.createSession(sessionInput)).rejects.toBeInstanceOf(StorePreconditionError);
    await store.saveDevboxLaunch(created.record.id, "i-test", "ca-central-1a");
    await store.transitionDevboxBootstrap(created.record.id, "READY", new Date(), null);
    const session = await store.createSession(sessionInput);
    expect(session.record.status).toBe("STARTING");
    const finished = await store.transitionSession(
      session.record.id,
      "SUCCEEDED",
      new Date(),
      0,
      null,
    );
    const delayed = await store.transitionSession(
      session.record.id,
      "RUNNING",
      new Date(),
      null,
      null,
    );
    expect(finished.status).toBe("SUCCEEDED");
    expect(delayed.status).toBe("SUCCEEDED");

    const activeSession = await store.createSession({
      ...sessionInput,
      id: `session_${randomUUID()}`,
      idempotencyKey: "database-session-2",
      requestHash: "1".repeat(64),
      tmuxName: `sfkm-${randomUUID()}`,
    });
    await store.transitionSession(activeSession.record.id, "RUNNING", new Date(), null, null);
    await store.markDevboxDeleting(created.record.id);
    const deletedAt = new Date();
    await store.markDevboxDeleted(created.record.id, deletedAt);
    await expect(store.getSession(activeSession.record.id)).resolves.toMatchObject({
      exitCode: null,
      finishedAt: deletedAt,
      status: "FAILED",
      statusReason: "Devbox was deleted.",
    });
  });
});
