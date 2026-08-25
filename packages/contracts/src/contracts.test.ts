import { describe, expect, it } from "vitest";

import {
  CreateSessionRequestSchema,
  DevboxIdSchema,
  DevboxStatusCallbackSchema,
  isDevboxTransitionAllowed,
  isSessionTransitionAllowed,
  SessionIdSchema,
  SessionStatusCallbackSchema,
} from "./index.js";

const devboxId = "devbox_2f1c9de0-f296-4e5d-9aaa-92d945e94ea2";
const sessionId = "session_ea69d7fd-c987-4990-a0c4-d05d78d53e5c";
const occurredAt = "2026-08-23T15:30:00Z";

describe("resource IDs", () => {
  it("accepts only prefixed UUIDs", () => {
    expect(DevboxIdSchema.parse(devboxId)).toBe(devboxId);
    expect(SessionIdSchema.parse(sessionId)).toBe(sessionId);
    expect(DevboxIdSchema.safeParse(sessionId).success).toBe(false);
  });
});

describe("lifecycle transitions", () => {
  it("allows monotonic devbox progress and idempotent repeats", () => {
    expect(isDevboxTransitionAllowed("PROVISIONING", "READY")).toBe(true);
    expect(isDevboxTransitionAllowed("READY", "READY")).toBe(true);
    expect(isDevboxTransitionAllowed("READY", "PROVISIONING")).toBe(false);
  });

  it("allows a fast session to skip RUNNING", () => {
    expect(isSessionTransitionAllowed("STARTING", "SUCCEEDED")).toBe(true);
    expect(isSessionTransitionAllowed("SUCCEEDED", "RUNNING")).toBe(false);
  });
});

describe("API privacy boundary", () => {
  it("does not accept an agent prompt in session creation", () => {
    expect(
      CreateSessionRequestSchema.safeParse({
        devboxId,
        prompt: "do not persist me",
      }).success,
    ).toBe(false);
  });
});

describe("callback contracts", () => {
  it("requires reasons for failures", () => {
    expect(
      DevboxStatusCallbackSchema.safeParse({
        occurredAt,
        status: "FAILED",
      }).success,
    ).toBe(false);

    expect(
      SessionStatusCallbackSchema.safeParse({
        exitCode: 1,
        occurredAt,
        reason: "agent process exited",
        status: "FAILED",
      }).success,
    ).toBe(true);
  });
});
