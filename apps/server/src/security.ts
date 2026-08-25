import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type ResourceTokenPurpose = "devbox-bootstrap" | "session-callback";

export function deriveResourceToken(
  key: string,
  purpose: ResourceTokenPurpose,
  resourceId: string,
): string {
  return createHmac("sha256", key).update(`${purpose}:${resourceId}`, "utf8").digest("hex");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function tokenMatchesHash(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashToken(token), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function readBearerToken(header: string | undefined): string | undefined {
  if (header === undefined) {
    return undefined;
  }
  const match = /^Bearer ([^\s]+)$/.exec(header);
  return match?.[1];
}

export function isBearerTokenAuthorized(
  header: string | undefined,
  expectedHash: string,
): boolean {
  const token = readBearerToken(header);
  return token !== undefined && tokenMatchesHash(token, expectedHash);
}
