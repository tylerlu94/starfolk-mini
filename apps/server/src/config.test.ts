import { describe, expect, it } from "vitest";

import { loadConfig } from "./config.js";

const validEnvironment = {
  AWS_ACCESS_KEY_ID: "test-access-key-id",
  AWS_REGION: "ca-central-1",
  AWS_SECRET_ACCESS_KEY: "example-secret-access-key-with-safe-length",
  DATABASE_URL: "postgres://localhost/sfkm",
  PORT: "3000",
  SFKM_AMI_ID: "ami-test",
  SFKM_API_TOKEN_HASH: "a".repeat(64),
  SFKM_DEFAULT_AGENT: "codex",
  SFKM_DEFAULT_MODEL: "gpt-test",
  SFKM_DEMO_SSH_CIDR: "192.0.2.10/32",
  SFKM_INSTANCE_TYPE: "t3.small",
  SFKM_PUBLIC_BASE_URL: "https://api.example.test/",
  SFKM_RESOURCE_TOKEN_KEY: "a-resource-key-that-is-at-least-32-bytes",
  SFKM_ROOT_DISK_GB: "24",
  SFKM_RUNTIME_ARTIFACT_SHA256: "b".repeat(64),
  SFKM_SECURITY_GROUP_ID: "sg-test",
  SFKM_SETUP_COMMAND: "npm ci",
  SFKM_SUBNET_ID: "subnet-test",
};

describe("server configuration", () => {
  it("validates and normalizes startup configuration", () => {
    const config = loadConfig(validEnvironment);
    expect(config.port).toBe(3000);
    expect(config.publicBaseUrl).toBe("https://api.example.test");
    expect(config.environment.configurationHash).toMatch(/^[0-9a-f]{64}$/);
    expect(config.environment.runtimeArtifactVersion).toBe("bbbbbbbbbbbb");
  });

  it("produces a new immutable-environment hash when launch configuration changes", () => {
    const first = loadConfig(validEnvironment);
    const second = loadConfig({ ...validEnvironment, SFKM_ROOT_DISK_GB: "32" });
    expect(second.environment.configurationHash).not.toBe(first.environment.configurationHash);
  });

  it("rejects an insecure callback URL", () => {
    expect(() => loadConfig({ ...validEnvironment, SFKM_PUBLIC_BASE_URL: "http://localhost:3000" }))
      .toThrow();
  });
});
