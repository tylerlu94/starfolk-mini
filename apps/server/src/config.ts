import { createHash } from "node:crypto";

import { z } from "zod";

const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/i);

const environmentSchema = z.object({
  AWS_ACCESS_KEY_ID: z.string().min(16),
  AWS_REGION: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(32),
  DATABASE_URL: z.string().regex(/^postgres(?:ql)?:\/\//),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  SFKM_AMI_ID: z.string().min(1),
  SFKM_API_TOKEN_HASH: sha256Schema,
  SFKM_DEFAULT_AGENT: z.string().min(1),
  SFKM_DEFAULT_MODEL: z.string().min(1),
  SFKM_DEMO_SSH_CIDR: z.string().regex(/^\d{1,3}(?:\.\d{1,3}){3}\/32$/),
  SFKM_INSTANCE_TYPE: z.string().min(1),
  SFKM_PUBLIC_BASE_URL: z.url().startsWith("https://"),
  SFKM_RESOURCE_TOKEN_KEY: z.string().min(32),
  SFKM_ROOT_DISK_GB: z.coerce.number().int().positive(),
  SFKM_RUNTIME_ARTIFACT_SHA256: sha256Schema,
  SFKM_SECURITY_GROUP_ID: z.string().min(1),
  SFKM_SETUP_COMMAND: z.string(),
  SFKM_SUBNET_ID: z.string().min(1),
});

export interface ServerConfig {
  readonly apiTokenHash: string;
  readonly awsRegion: string;
  readonly databaseUrl: string;
  readonly environment: {
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
  };
  readonly port: number;
  readonly publicBaseUrl: string;
  readonly resourceTokenKey: string;
  readonly securityGroupId: string;
  readonly sshSourceCidr: string;
  readonly subnetId: string;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): ServerConfig {
  const value = environmentSchema.parse(source);
  const environmentValues = {
    amiId: value.SFKM_AMI_ID,
    defaultAgent: value.SFKM_DEFAULT_AGENT,
    defaultModel: value.SFKM_DEFAULT_MODEL,
    instanceType: value.SFKM_INSTANCE_TYPE,
    rootDiskGb: value.SFKM_ROOT_DISK_GB,
    runtimeArtifactSha256: value.SFKM_RUNTIME_ARTIFACT_SHA256.toLowerCase(),
    setupCommand: value.SFKM_SETUP_COMMAND,
  };
  const configurationHash = sha256(JSON.stringify(environmentValues));

  return {
    apiTokenHash: value.SFKM_API_TOKEN_HASH.toLowerCase(),
    awsRegion: value.AWS_REGION,
    databaseUrl: value.DATABASE_URL,
    environment: {
      ...environmentValues,
      configurationHash,
      runtimeArtifactVersion: value.SFKM_RUNTIME_ARTIFACT_SHA256.slice(0, 12).toLowerCase(),
      version: configurationHash.slice(0, 12),
    },
    port: value.PORT,
    publicBaseUrl: value.SFKM_PUBLIC_BASE_URL.replace(/\/$/, ""),
    resourceTokenKey: value.SFKM_RESOURCE_TOKEN_KEY,
    securityGroupId: value.SFKM_SECURITY_GROUP_ID,
    sshSourceCidr: value.SFKM_DEMO_SSH_CIDR,
    subnetId: value.SFKM_SUBNET_ID,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
