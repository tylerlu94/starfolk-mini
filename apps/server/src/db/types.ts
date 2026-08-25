import type { DevboxStatus, RepositoryReference, SessionStatus } from "@sfkm/contracts";

export interface EnvironmentSeed {
  readonly amiId: string;
  readonly configurationHash: string;
  readonly defaultAgent: string;
  readonly defaultModel: string;
  readonly instanceType: string;
  readonly rootDiskGb: number;
  readonly runtimeArtifactSha256: string;
  readonly runtimeArtifactVersion: string;
  readonly setupCommand: string;
  readonly version: string;
}

export interface EnvironmentRecord extends EnvironmentSeed {
  readonly id: string;
}

export interface NewDevboxRecord {
  readonly awsClientToken: string;
  readonly bootstrapDeadlineAt: Date;
  readonly bootstrapTokenHash: string;
  readonly environmentId: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly repository: RepositoryReference;
  readonly requestHash: string;
}

export interface DevboxRecord extends NewDevboxRecord {
  readonly awsAvailabilityZone: string | null;
  readonly awsInstanceId: string | null;
  readonly createdAt: Date;
  readonly deletedAt: Date | null;
  readonly publicHostname: string | null;
  readonly readyAt: Date | null;
  readonly status: DevboxStatus;
  readonly statusReason: string | null;
  readonly updatedAt: Date;
}

export interface NewSessionRecord {
  readonly agent: string;
  readonly callbackTokenHash: string;
  readonly devboxId: string;
  readonly id: string;
  readonly idempotencyKey: string;
  readonly model: string;
  readonly requestHash: string;
  readonly startDeadlineAt: Date;
  readonly tmuxName: string;
}

export interface SessionRecord extends NewSessionRecord {
  readonly createdAt: Date;
  readonly exitCode: number | null;
  readonly finishedAt: Date | null;
  readonly startedAt: Date | null;
  readonly status: SessionStatus;
  readonly statusReason: string | null;
  readonly updatedAt: Date;
}

export interface Store {
  close(): Promise<void>;
  createDevbox(input: NewDevboxRecord): Promise<{ inserted: boolean; record: DevboxRecord }>;
  createSession(input: NewSessionRecord): Promise<{ inserted: boolean; record: SessionRecord }>;
  getDefaultEnvironment(): Promise<EnvironmentRecord>;
  getDevbox(id: string): Promise<DevboxRecord | undefined>;
  getSession(id: string): Promise<SessionRecord | undefined>;
  isReady(): Promise<boolean>;
  expireOverdueDevboxes(now: Date): Promise<number>;
  expireOverdueSessions(now: Date): Promise<number>;
  listReconcilableDevboxes(): Promise<readonly DevboxRecord[]>;
  markDevboxDeleted(id: string, occurredAt: Date): Promise<DevboxRecord>;
  markDevboxDeleting(id: string): Promise<DevboxRecord | undefined>;
  saveDevboxLaunch(
    id: string,
    instanceId: string,
    availabilityZone: string,
  ): Promise<DevboxRecord>;
  seedDefaultEnvironment(input: EnvironmentSeed): Promise<EnvironmentRecord>;
  setDevboxHostname(id: string, hostname: string): Promise<void>;
  transitionDevboxBootstrap(
    id: string,
    status: "READY" | "FAILED",
    occurredAt: Date,
    reason: string | null,
  ): Promise<DevboxRecord>;
  transitionSession(
    id: string,
    status: "RUNNING" | "SUCCEEDED" | "FAILED",
    occurredAt: Date,
    exitCode: number | null,
    reason: string | null,
  ): Promise<SessionRecord>;
}

export class StorePreconditionError extends Error {
  constructor(readonly condition: "DEVBOX_NOT_READY" | "DEVBOX_NOT_FOUND") {
    super(condition);
    this.name = "StorePreconditionError";
  }
}
