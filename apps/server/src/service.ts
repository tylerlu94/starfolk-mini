import { createHash, randomUUID } from "node:crypto";

import type {
  AuthorizeSshKeyRequest,
  CreateDevboxRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  Devbox,
  DevboxStatusCallback,
  Session,
  SessionStatusCallback,
} from "@sfkm/contracts";

import type { AwsDevboxProvider } from "./aws/port.js";
import type { ServerConfig } from "./config.js";
import { StorePreconditionError, type DevboxRecord, type SessionRecord, type Store } from "./db/types.js";
import { ApiError } from "./errors.js";
import { deriveResourceToken, hashToken, tokenMatchesHash } from "./security.js";

const operationLifetimeMs = 30 * 60 * 1_000;
const pinnedCodexNpmSpec = "@openai/codex@0.146.0";

export interface BackendServiceOptions {
  readonly clock?: () => Date;
}

export interface ReconciliationReport {
  readonly expiredDevboxes: number;
  readonly expiredSessions: number;
  readonly failedDevboxes: number;
  readonly reconciledDevboxes: number;
}

export class BackendService {
  private readonly clock: () => Date;

  constructor(
    private readonly store: Store,
    private readonly aws: AwsDevboxProvider,
    private readonly config: ServerConfig,
    options: BackendServiceOptions = {},
  ) {
    this.clock = options.clock ?? (() => new Date());
  }

  async reconcileStartup(): Promise<ReconciliationReport> {
    const reconciliationTime = this.clock();
    const expiredDevboxes = await this.store.expireOverdueDevboxes(reconciliationTime);
    const expiredSessions = await this.store.expireOverdueSessions(reconciliationTime);
    const records = await this.store.listReconcilableDevboxes();
    let reconciledDevboxes = 0;
    let failedDevboxes = 0;
    for (const record of records) {
      try {
        if (record.status === "DELETING") {
          if (record.awsInstanceId !== null) {
            await this.aws.terminateDevbox(record.awsInstanceId);
          }
          await this.store.markDevboxDeleted(record.id, reconciliationTime);
        } else if (record.awsInstanceId === null) {
          await this.createDevbox({ repository: record.repository }, record.idempotencyKey);
        }
        reconciledDevboxes += 1;
      } catch {
        failedDevboxes += 1;
      }
    }
    return { expiredDevboxes, expiredSessions, failedDevboxes, reconciledDevboxes };
  }

  async createDevbox(
    request: CreateDevboxRequest,
    idempotencyKey: string,
  ): Promise<Devbox> {
    const environment = await this.store.getDefaultEnvironment();
    const id = `devbox_${randomUUID()}`;
    const rawBootstrapToken = deriveResourceToken(
      this.config.resourceTokenKey,
      "devbox-bootstrap",
      id,
    );
    const result = await this.store.createDevbox({
      awsClientToken: randomUUID(),
      bootstrapDeadlineAt: new Date(this.clock().getTime() + operationLifetimeMs),
      bootstrapTokenHash: hashToken(rawBootstrapToken),
      environmentId: environment.id,
      id,
      idempotencyKey,
      repository: request.repository,
      requestHash: requestHash(request),
    });
    const record = result.record;
    if (record.requestHash !== requestHash(request)) {
      throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was used for another request.");
    }

    if (record.awsInstanceId === null && record.status === "PROVISIONING") {
      const bootstrapToken = deriveResourceToken(
        this.config.resourceTokenKey,
        "devbox-bootstrap",
        record.id,
      );
      let launch;
      try {
        launch = await this.aws.launchDevbox({
          amiId: environment.amiId,
          clientToken: record.awsClientToken,
          instanceType: environment.instanceType,
          rootDiskGb: environment.rootDiskGb,
          securityGroupId: this.config.securityGroupId,
          subnetId: this.config.subnetId,
          tags: {
            EnvironmentVersion: environment.version,
            Owner: "interview-demo",
            Project: "sfkm-demo",
            SFKMDevboxId: record.id,
          },
          userData: buildUserData({
            agentNpmSpec: pinnedCodexNpmSpec,
            artifactSha256: environment.runtimeArtifactSha256,
            artifactUrl: `${this.config.publicBaseUrl}/artifacts/sfkm-devbox-runtime`,
            bootstrapToken,
            callbackUrl: `${this.config.publicBaseUrl}/v1/internal/devboxes/${record.id}/status`,
            devboxId: record.id,
            repository: record.repository,
            setupCommand: environment.setupCommand,
          }),
        });
      } catch {
        const latest = await this.store.getDevbox(record.id);
        if (latest?.status === "PROVISIONING") {
          await this.store.transitionDevboxBootstrap(
            record.id,
            "FAILED",
            this.clock(),
            "AWS instance launch failed.",
          );
        }
        throw new ApiError(503, "AWS_CAPACITY_UNAVAILABLE", "Unable to launch the devbox instance.");
      }
      const launched = await this.store.saveDevboxLaunch(
        record.id,
        launch.instanceId,
        launch.availabilityZone,
      );
      if (launched.status === "DELETING" || launched.status === "DELETED") {
        await this.aws.terminateDevbox(launch.instanceId);
        return toDevbox(
          launched.status === "DELETING"
            ? await this.store.markDevboxDeleted(record.id, this.clock())
            : launched,
        );
      }
      return toDevbox(launched);
    }
    return toDevbox(record);
  }

  async getDevbox(id: string): Promise<Devbox> {
    return toDevbox(await this.requireDevbox(id));
  }

  async deleteDevbox(id: string): Promise<Devbox> {
    const record = await this.store.markDevboxDeleting(id);
    if (record === undefined) {
      throw new ApiError(404, "DEVBOX_NOT_FOUND", "Devbox was not found.");
    }
    if (record.status === "DELETED") {
      return toDevbox(record);
    }
    if (record.awsInstanceId === null) {
      return toDevbox(await this.store.markDevboxDeleted(id, this.clock()));
    }
    if (record.status === "DELETING") {
      await this.aws.terminateDevbox(record.awsInstanceId);
      return toDevbox(await this.store.markDevboxDeleted(id, this.clock()));
    }
    return toDevbox(record);
  }

  async authorizeSsh(
    id: string,
    request: AuthorizeSshKeyRequest,
  ): Promise<{ host: string; port: number; username: string }> {
    const record = await this.requireDevbox(id);
    if (record.status !== "READY" || record.awsInstanceId === null || record.awsAvailabilityZone === null) {
      throw new ApiError(409, "DEVBOX_NOT_READY", "Devbox is not ready for SSH.");
    }
    try {
      const details = await this.aws.getConnectionDetails(record.awsInstanceId);
      await this.aws.authorizeSshKey({
        availabilityZone: record.awsAvailabilityZone,
        instanceId: record.awsInstanceId,
        osUser: "ec2-user",
        publicKey: request.publicKey,
      });
      await this.store.setDevboxHostname(id, details.host);
      return { host: details.host, port: 22, username: "ec2-user" };
    } catch {
      throw new ApiError(502, "SSH_AUTHORIZATION_FAILED", "Unable to authorize the SSH key.");
    }
  }

  async createSession(
    request: CreateSessionRequest,
    idempotencyKey: string,
  ): Promise<CreateSessionResponse> {
    const environment = await this.store.getDefaultEnvironment();
    const id = `session_${randomUUID()}`;
    const callbackToken = deriveResourceToken(
      this.config.resourceTokenKey,
      "session-callback",
      id,
    );
    let result;
    try {
      result = await this.store.createSession({
        agent: environment.defaultAgent,
        callbackTokenHash: hashToken(callbackToken),
        devboxId: request.devboxId,
        id,
        idempotencyKey,
        model: environment.defaultModel,
        requestHash: requestHash(request),
        startDeadlineAt: new Date(this.clock().getTime() + operationLifetimeMs),
        tmuxName: `sfkm-${id}`,
      });
    } catch (error: unknown) {
      if (error instanceof StorePreconditionError) {
        if (error.condition === "DEVBOX_NOT_FOUND") {
          throw new ApiError(404, "DEVBOX_NOT_FOUND", "Devbox was not found.");
        }
        throw new ApiError(409, "DEVBOX_NOT_READY", "Devbox is not ready for a session.");
      }
      throw error;
    }
    if (result.record.requestHash !== requestHash(request)) {
      throw new ApiError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was used for another request.");
    }
    const replayToken = deriveResourceToken(
      this.config.resourceTokenKey,
      "session-callback",
      result.record.id,
    );
    return {
      callbackToken: replayToken,
      callbackUrl: `${this.config.publicBaseUrl}/v1/internal/sessions/${result.record.id}/status`,
      devboxId: result.record.devboxId,
      id: result.record.id,
      status: "STARTING",
    };
  }

  async getSession(id: string): Promise<Session> {
    const record = await this.store.getSession(id);
    if (record === undefined) {
      throw new ApiError(404, "SESSION_NOT_FOUND", "Session was not found.");
    }
    return toSession(record);
  }

  async updateDevboxStatus(
    id: string,
    token: string | undefined,
    callback: DevboxStatusCallback,
  ): Promise<Devbox> {
    const record = await this.requireDevbox(id);
    if (record.status !== "PROVISIONING") {
      return toDevbox(record);
    }
    requireResourceToken(token, record.bootstrapTokenHash, record.bootstrapDeadlineAt, this.clock());
    const updated = await this.store.transitionDevboxBootstrap(
      id,
      callback.status,
      new Date(callback.occurredAt),
      callback.status === "FAILED" ? callback.reason : null,
    );
    return toDevbox(updated);
  }

  async updateSessionStatus(
    id: string,
    token: string | undefined,
    callback: SessionStatusCallback,
  ): Promise<Session> {
    const record = await this.store.getSession(id);
    if (record === undefined) {
      throw new ApiError(404, "SESSION_NOT_FOUND", "Session was not found.");
    }
    if (record.status === "SUCCEEDED" || record.status === "FAILED") {
      return toSession(record);
    }
    requireResourceToken(token, record.callbackTokenHash, record.startDeadlineAt, this.clock());
    const updated = await this.store.transitionSession(
      id,
      callback.status,
      new Date(callback.occurredAt),
      callback.status === "RUNNING" ? null : callback.exitCode,
      callback.status === "FAILED" ? callback.reason : null,
    );
    return toSession(updated);
  }

  private async requireDevbox(id: string): Promise<DevboxRecord> {
    const record = await this.store.getDevbox(id);
    if (record === undefined) {
      throw new ApiError(404, "DEVBOX_NOT_FOUND", "Devbox was not found.");
    }
    return record;
  }
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function requireResourceToken(
  token: string | undefined,
  expectedHash: string,
  deadline: Date,
  now: Date,
): void {
  if (token === undefined || now > deadline || !tokenMatchesHash(token, expectedHash)) {
    throw new ApiError(401, "UNAUTHORIZED", "Resource token is invalid or expired.");
  }
}

function toDevbox(record: DevboxRecord): Devbox {
  return {
    createdAt: record.createdAt.toISOString(),
    environmentId: record.environmentId,
    id: record.id,
    publicHostname: record.publicHostname,
    readyAt: record.readyAt?.toISOString() ?? null,
    repository: record.repository,
    status: record.status,
    statusReason: record.statusReason,
    updatedAt: record.updatedAt.toISOString(),
  } as Devbox;
}

function toSession(record: SessionRecord): Session {
  return {
    agent: record.agent,
    createdAt: record.createdAt.toISOString(),
    devboxId: record.devboxId,
    exitCode: record.exitCode,
    finishedAt: record.finishedAt?.toISOString() ?? null,
    id: record.id,
    model: record.model,
    startedAt: record.startedAt?.toISOString() ?? null,
    status: record.status,
    statusReason: record.statusReason,
    updatedAt: record.updatedAt.toISOString(),
  } as Session;
}

interface UserDataInput {
  readonly agentNpmSpec: string;
  readonly artifactSha256: string;
  readonly artifactUrl: string;
  readonly bootstrapToken: string;
  readonly callbackUrl: string;
  readonly devboxId: string;
  readonly repository: CreateDevboxRequest["repository"];
  readonly setupCommand: string;
}

export function buildUserData(input: UserDataInput): string {
  const metadata = Buffer.from(
    JSON.stringify({
      bootstrapToken: input.bootstrapToken,
      callbackUrl: input.callbackUrl,
      devboxId: input.devboxId,
      repository: input.repository,
      setupCommand: input.setupCommand,
    }),
    "utf8",
  ).toString("base64");
  const artifactUrl = Buffer.from(input.artifactUrl, "utf8").toString("base64");
  const agentNpmSpec = Buffer.from(input.agentNpmSpec, "utf8").toString("base64");
  return `#!/bin/bash
set -euo pipefail
dnf install -y gcc-c++ git make tmux nodejs24 nodejs24-npm
agent_npm_spec="$(printf '%s' '${agentNpmSpec}' | base64 --decode)"
npm install --global "$agent_npm_spec"
install -d -o ec2-user -g ec2-user -m 0700 /workspace /var/lib/sfkm /var/lib/sfkm/sessions
printf '%s' '${metadata}' | base64 --decode > /var/lib/sfkm/bootstrap.json
chmod 0600 /var/lib/sfkm/bootstrap.json
chown ec2-user:ec2-user /var/lib/sfkm/bootstrap.json
artifact_url="$(printf '%s' '${artifactUrl}' | base64 --decode)"
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location "$artifact_url" --output /usr/local/bin/sfkm-devbox-runtime
printf '%s  %s\n' '${input.artifactSha256}' /usr/local/bin/sfkm-devbox-runtime | sha256sum --check --status
chmod 0755 /usr/local/bin/sfkm-devbox-runtime
runuser -u ec2-user -- /usr/local/bin/sfkm-devbox-runtime bootstrap < /var/lib/sfkm/bootstrap.json
rm -f /var/lib/sfkm/bootstrap.json
`;
}
