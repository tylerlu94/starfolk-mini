import { describe, expect, it } from "vitest";

import {
  deriveResourceToken,
  hashToken,
  isBearerTokenAuthorized,
  readBearerToken,
  tokenMatchesHash,
} from "./security.js";

describe("token security", () => {
  it("derives deterministic purpose-scoped resource tokens", () => {
    const key = "a-resource-key-that-is-at-least-32-bytes";
    const first = deriveResourceToken(key, "devbox-bootstrap", "devbox_1");
    expect(deriveResourceToken(key, "devbox-bootstrap", "devbox_1")).toBe(first);
    expect(deriveResourceToken(key, "session-callback", "devbox_1")).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches hashes without storing the raw token", () => {
    const hash = hashToken("secret-token");
    expect(tokenMatchesHash("secret-token", hash)).toBe(true);
    expect(tokenMatchesHash("other-token", hash)).toBe(false);
  });

  it("accepts only a strict bearer header", () => {
    expect(readBearerToken("Bearer token")).toBe("token");
    expect(readBearerToken("bearer token")).toBeUndefined();
    expect(readBearerToken("Bearer token extra")).toBeUndefined();
  });

  it("authorizes a bearer token against only its stored hash", () => {
    const hash = hashToken("demo-token");
    expect(isBearerTokenAuthorized("Bearer demo-token", hash)).toBe(true);
    expect(isBearerTokenAuthorized("Bearer wrong-token", hash)).toBe(false);
    expect(isBearerTokenAuthorized(undefined, hash)).toBe(false);
  });
});
