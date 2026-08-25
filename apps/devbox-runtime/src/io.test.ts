import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { readBoundedJson } from "./io.js";
import {
  BootstrapInputSchema,
  CallbackUrlSchema,
  SessionIdArgumentSchema,
  SessionStartInputSchema,
} from "./schemas.js";

const validSessionInput = {
  callbackToken: "t".repeat(64),
  prompt: "safe prompt",
};

describe("bounded strict input", () => {
  it("rejects an oversized stdin payload", async () => {
    await expect(
      readBoundedJson(
        Readable.from([JSON.stringify(validSessionInput)]),
        10,
        SessionStartInputSchema,
      ),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects unexpected JSON fields without echoing their values", async () => {
    const secret = "must-not-appear";
    await expect(
      readBoundedJson(
        Readable.from([JSON.stringify({ ...validSessionInput, unexpected: secret })]),
        1024,
        SessionStartInputSchema,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
      message: expect.not.stringContaining(secret),
    });
  });
});

describe("untrusted identifiers and URLs", () => {
  it("rejects traversal IDs and non-loopback plain HTTP callbacks", () => {
    expect(SessionIdArgumentSchema.safeParse("session_../../etc/passwd").success).toBe(false);
    expect(CallbackUrlSchema.safeParse("http://api.example.test/status").success).toBe(false);
    expect(CallbackUrlSchema.safeParse("http://127.0.0.1/status").success).toBe(true);
  });

  it("rejects repository credentials and unsafe branch syntax", () => {
    const base = {
      bootstrapToken: "b".repeat(64),
      callbackUrl: "https://api.example.test/status",
      devboxId: "devbox_2f1c9de0-f296-4e5d-9aaa-92d945e94ea2",
      repository: {
        branch: "main",
        commitSha: "0".repeat(40),
        url: "https://user:password@example.test/repo.git",
      },
      setupCommand: "npm ci",
    };
    expect(BootstrapInputSchema.safeParse(base).success).toBe(false);
    expect(
      BootstrapInputSchema.safeParse({
        ...base,
        repository: {
          ...base.repository,
          branch: "main\"inject",
          url: "https://example.test/repo.git",
        },
      }).success,
    ).toBe(false);
  });
});
