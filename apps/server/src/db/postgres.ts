import { randomUUID } from "node:crypto";

import { Pool, type QueryResultRow } from "pg";

import type { DevboxStatus, RepositoryReference, SessionStatus } from "@sfkm/contracts";

import type {
  DevboxRecord,
  EnvironmentRecord,
  EnvironmentSeed,
  NewDevboxRecord,
  NewSessionRecord,
  SessionRecord,
  Store,
} from "./types.js";
import { StorePreconditionError } from "./types.js";

interface EnvironmentRow extends QueryResultRow {
  ami_id: string;
  configuration_hash: string;
  default_agent: string;
  default_model: string;
  id: string;
  instance_type: string;
  root_disk_gb: number;
  runtime_artifact_sha256: string;
  runtime_artifact_version: string;
  setup_command: string;
  version: string;
}

interface DevboxRow extends QueryResultRow {
  aws_availability_zone: string | null;
  aws_client_token: string;
  aws_instance_id: string | null;
  bootstrap_deadline_at: Date;
  bootstrap_token_hash: string | null;
  branch: string;
  commit_sha: string;
  created_at: Date;
  deleted_at: Date | null;
  environment_id: string;
  id: string;
  idempotency_key: string;
  public_hostname: string | null;
  ready_at: Date | null;
  repo_url: string;
  request_hash: string;
  status: DevboxStatus;
  status_reason: string | null;
  updated_at: Date;
}

interface SessionRow extends QueryResultRow {
  agent: string;
  callback_token_hash: string | null;
  created_at: Date;
  devbox_id: string;
  exit_code: number | null;
  finished_at: Date | null;
  id: string;
  idempotency_key: string;
  model: string;
  request_hash: string;
  start_deadline_at: Date;
  started_at: Date | null;
  status: SessionStatus;
  status_reason: string | null;
  tmux_name: string;
  updated_at: Date;
}

export class PostgresStore implements Store {
  readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString, max: 10 });
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async isReady(): Promise<boolean> {
    await this.pool.query("SELECT 1");
    return true;
  }

  async expireOverdueDevboxes(now: Date): Promise<number> {
    const result = await this.pool.query(
      `UPDATE devboxes SET status = 'FAILED', status_reason = 'Bootstrap deadline expired.',
        bootstrap_token_hash = NULL, updated_at = now()
      WHERE status = 'PROVISIONING' AND bootstrap_deadline_at < $1`,
      [now],
    );
    return result.rowCount ?? 0;
  }

  async expireOverdueSessions(now: Date): Promise<number> {
    const result = await this.pool.query(
      `UPDATE sessions SET status = 'FAILED', status_reason = 'Session start deadline expired.',
        callback_token_hash = NULL, finished_at = $1, updated_at = now()
      WHERE status = 'STARTING' AND start_deadline_at < $1`,
      [now],
    );
    return result.rowCount ?? 0;
  }

  async listReconcilableDevboxes(): Promise<readonly DevboxRecord[]> {
    const result = await this.pool.query<DevboxRow>(
      "SELECT * FROM devboxes WHERE status IN ('PROVISIONING', 'DELETING') ORDER BY created_at",
    );
    return result.rows.map(mapDevbox);
  }

  async seedDefaultEnvironment(input: EnvironmentSeed): Promise<EnvironmentRecord> {
    const existing = await this.pool.query<EnvironmentRow>(
      "SELECT * FROM environments WHERE is_default = true",
    );
    const row = existing.rows[0];
    if (row !== undefined) {
      if (row.configuration_hash !== input.configurationHash) {
        throw new Error("The seeded default environment does not match deployment configuration.");
      }
      return mapEnvironment(row);
    }

    const inserted = await this.pool.query<EnvironmentRow>(
      `INSERT INTO environments (
        id, version, is_default, ami_id, instance_type, root_disk_gb, default_agent,
        default_model, setup_command, runtime_artifact_version,
        runtime_artifact_sha256, configuration_hash
      ) VALUES ($1, $2, true, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *`,
      [
        `env_${randomUUID()}`,
        input.version,
        input.amiId,
        input.instanceType,
        input.rootDiskGb,
        input.defaultAgent,
        input.defaultModel,
        input.setupCommand,
        input.runtimeArtifactVersion,
        input.runtimeArtifactSha256,
        input.configurationHash,
      ],
    );
    return mapEnvironment(requiredRow(inserted.rows[0]));
  }

  async getDefaultEnvironment(): Promise<EnvironmentRecord> {
    const result = await this.pool.query<EnvironmentRow>(
      "SELECT * FROM environments WHERE is_default = true",
    );
    return mapEnvironment(requiredRow(result.rows[0]));
  }

  async createDevbox(
    input: NewDevboxRecord,
  ): Promise<{ inserted: boolean; record: DevboxRecord }> {
    const result = await this.pool.query<DevboxRow>(
      `INSERT INTO devboxes (
        id, environment_id, idempotency_key, request_hash, repo_url, branch,
        commit_sha, status, aws_client_token, bootstrap_token_hash, bootstrap_deadline_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PROVISIONING', $8, $9, $10)
      ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [
        input.id,
        input.environmentId,
        input.idempotencyKey,
        input.requestHash,
        input.repository.url,
        input.repository.branch,
        input.repository.commitSha,
        input.awsClientToken,
        input.bootstrapTokenHash,
        input.bootstrapDeadlineAt,
      ],
    );
    const inserted = result.rows[0];
    if (inserted !== undefined) {
      return { inserted: true, record: mapDevbox(inserted) };
    }
    const existing = await this.pool.query<DevboxRow>(
      "SELECT * FROM devboxes WHERE idempotency_key = $1",
      [input.idempotencyKey],
    );
    return { inserted: false, record: mapDevbox(requiredRow(existing.rows[0])) };
  }

  async getDevbox(id: string): Promise<DevboxRecord | undefined> {
    const result = await this.pool.query<DevboxRow>("SELECT * FROM devboxes WHERE id = $1", [id]);
    const row = result.rows[0];
    return row === undefined ? undefined : mapDevbox(row);
  }

  async saveDevboxLaunch(
    id: string,
    instanceId: string,
    availabilityZone: string,
  ): Promise<DevboxRecord> {
    const result = await this.pool.query<DevboxRow>(
      `UPDATE devboxes SET
        aws_instance_id = COALESCE(aws_instance_id, $2),
        aws_availability_zone = COALESCE(aws_availability_zone, $3),
        updated_at = now()
      WHERE id = $1 AND (aws_instance_id IS NULL OR aws_instance_id = $2)
      RETURNING *`,
      [id, instanceId, availabilityZone],
    );
    return mapDevbox(requiredRow(result.rows[0]));
  }

  async markDevboxDeleting(id: string): Promise<DevboxRecord | undefined> {
    const updated = await this.pool.query<DevboxRow>(
      `UPDATE devboxes SET status = 'DELETING', status_reason = NULL,
        bootstrap_token_hash = NULL, updated_at = now()
      WHERE id = $1 AND status IN ('PROVISIONING', 'READY', 'FAILED') RETURNING *`,
      [id],
    );
    const row = updated.rows[0];
    if (row !== undefined) {
      return mapDevbox(row);
    }
    return this.getDevbox(id);
  }

  async markDevboxDeleted(id: string, occurredAt: Date): Promise<DevboxRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE devboxes SET status = 'DELETED', deleted_at = COALESCE(deleted_at, $2),
          updated_at = now() WHERE id = $1 AND status = 'DELETING'`,
        [id, occurredAt],
      );
      const result = await client.query<DevboxRow>(
        "SELECT * FROM devboxes WHERE id = $1 FOR UPDATE",
        [id],
      );
      const row = requiredRow(result.rows[0]);
      if (row.status === "DELETED") {
        await client.query(
          `UPDATE sessions SET status = 'FAILED', status_reason = 'Devbox was deleted.',
            exit_code = NULL, finished_at = COALESCE(finished_at, $2),
            callback_token_hash = NULL, updated_at = now()
          WHERE devbox_id = $1 AND status IN ('STARTING', 'RUNNING')`,
          [id, occurredAt],
        );
      }
      await client.query("COMMIT");
      return mapDevbox(row);
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async setDevboxHostname(id: string, hostname: string): Promise<void> {
    await this.pool.query(
      "UPDATE devboxes SET public_hostname = $2, updated_at = now() WHERE id = $1",
      [id, hostname],
    );
  }

  async transitionDevboxBootstrap(
    id: string,
    status: "READY" | "FAILED",
    occurredAt: Date,
    reason: string | null,
  ): Promise<DevboxRecord> {
    const result = await this.pool.query<DevboxRow>(
      `UPDATE devboxes SET status = $2, status_reason = $3,
        ready_at = CASE WHEN $2 = 'READY' THEN $4 ELSE ready_at END,
        bootstrap_token_hash = NULL, updated_at = now()
      WHERE id = $1 AND status = 'PROVISIONING' RETURNING *`,
      [id, status, reason, occurredAt],
    );
    return mapDevbox(requiredRow(result.rows[0] ?? (await this.getDevboxRow(id))));
  }

  async createSession(
    input: NewSessionRecord,
  ): Promise<{ inserted: boolean; record: SessionRecord }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<SessionRow>(
        "SELECT * FROM sessions WHERE idempotency_key = $1",
        [input.idempotencyKey],
      );
      if (existing.rows[0] !== undefined) {
        await client.query("COMMIT");
        return { inserted: false, record: mapSession(existing.rows[0]) };
      }
      const devbox = await client.query<{ status: DevboxStatus }>(
        "SELECT status FROM devboxes WHERE id = $1 FOR SHARE",
        [input.devboxId],
      );
      if (devbox.rows[0] === undefined) {
        throw new StorePreconditionError("DEVBOX_NOT_FOUND");
      }
      if (devbox.rows[0].status !== "READY") {
        throw new StorePreconditionError("DEVBOX_NOT_READY");
      }
      const result = await client.query<SessionRow>(
        `INSERT INTO sessions (
        id, devbox_id, idempotency_key, request_hash, agent, model, tmux_name,
        status, callback_token_hash, start_deadline_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'STARTING', $8, $9)
      ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
        [
          input.id,
          input.devboxId,
          input.idempotencyKey,
          input.requestHash,
          input.agent,
          input.model,
          input.tmuxName,
          input.callbackTokenHash,
          input.startDeadlineAt,
        ],
      );
      const inserted = result.rows[0];
      if (inserted !== undefined) {
        await client.query("COMMIT");
        return { inserted: true, record: mapSession(inserted) };
      }
      const raced = await client.query<SessionRow>(
        "SELECT * FROM sessions WHERE idempotency_key = $1",
        [input.idempotencyKey],
      );
      await client.query("COMMIT");
      return { inserted: false, record: mapSession(requiredRow(raced.rows[0])) };
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const result = await this.pool.query<SessionRow>("SELECT * FROM sessions WHERE id = $1", [id]);
    const row = result.rows[0];
    return row === undefined ? undefined : mapSession(row);
  }

  async transitionSession(
    id: string,
    status: "RUNNING" | "SUCCEEDED" | "FAILED",
    occurredAt: Date,
    exitCode: number | null,
    reason: string | null,
  ): Promise<SessionRecord> {
    const allowed = status === "RUNNING" ? ["STARTING"] : ["STARTING", "RUNNING"];
    const result = await this.pool.query<SessionRow>(
      `UPDATE sessions SET status = $2, status_reason = $3, exit_code = $4,
        started_at = CASE WHEN $2 = 'RUNNING' THEN COALESCE(started_at, $5) ELSE started_at END,
        finished_at = CASE WHEN $2 IN ('SUCCEEDED', 'FAILED') THEN $5 ELSE finished_at END,
        callback_token_hash = CASE WHEN $2 IN ('SUCCEEDED', 'FAILED') THEN NULL ELSE callback_token_hash END,
        updated_at = now()
      WHERE id = $1 AND status = ANY($6::text[]) RETURNING *`,
      [id, status, reason, exitCode, occurredAt, allowed],
    );
    return mapSession(requiredRow(result.rows[0] ?? (await this.getSessionRow(id))));
  }

  private async getDevboxRow(id: string): Promise<DevboxRow | undefined> {
    const result = await this.pool.query<DevboxRow>("SELECT * FROM devboxes WHERE id = $1", [id]);
    return result.rows[0];
  }

  private async getSessionRow(id: string): Promise<SessionRow | undefined> {
    const result = await this.pool.query<SessionRow>("SELECT * FROM sessions WHERE id = $1", [id]);
    return result.rows[0];
  }
}

function requiredRow<Row>(row: Row | undefined): Row {
  if (row === undefined) {
    throw new Error("Expected database row was not found.");
  }
  return row;
}

function mapEnvironment(row: EnvironmentRow): EnvironmentRecord {
  return {
    amiId: row.ami_id,
    configurationHash: row.configuration_hash,
    defaultAgent: row.default_agent,
    defaultModel: row.default_model,
    id: row.id,
    instanceType: row.instance_type,
    rootDiskGb: row.root_disk_gb,
    runtimeArtifactSha256: row.runtime_artifact_sha256,
    runtimeArtifactVersion: row.runtime_artifact_version,
    setupCommand: row.setup_command,
    version: row.version,
  };
}

function mapDevbox(row: DevboxRow): DevboxRecord {
  return {
    awsAvailabilityZone: row.aws_availability_zone,
    awsClientToken: row.aws_client_token,
    awsInstanceId: row.aws_instance_id,
    bootstrapDeadlineAt: row.bootstrap_deadline_at,
    bootstrapTokenHash: row.bootstrap_token_hash ?? "",
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
    environmentId: row.environment_id,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    publicHostname: row.public_hostname,
    readyAt: row.ready_at,
    repository: repository(row),
    requestHash: row.request_hash,
    status: row.status,
    statusReason: row.status_reason,
    updatedAt: row.updated_at,
  };
}

function repository(row: DevboxRow): RepositoryReference {
  return { branch: row.branch, commitSha: row.commit_sha, url: row.repo_url };
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    agent: row.agent,
    callbackTokenHash: row.callback_token_hash ?? "",
    createdAt: row.created_at,
    devboxId: row.devbox_id,
    exitCode: row.exit_code,
    finishedAt: row.finished_at,
    id: row.id,
    idempotencyKey: row.idempotency_key,
    model: row.model,
    requestHash: row.request_hash,
    startDeadlineAt: row.start_deadline_at,
    startedAt: row.started_at,
    status: row.status,
    statusReason: row.status_reason,
    tmuxName: row.tmux_name,
    updatedAt: row.updated_at,
  };
}
