import { z } from "zod";

export const DevboxStatusSchema = z.enum([
  "PROVISIONING",
  "READY",
  "FAILED",
  "DELETING",
  "DELETED",
]);

export type DevboxStatus = z.infer<typeof DevboxStatusSchema>;

export const SessionStatusSchema = z.enum([
  "STARTING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
]);

export type SessionStatus = z.infer<typeof SessionStatusSchema>;

const devboxTransitions: Readonly<
  Record<DevboxStatus, ReadonlySet<DevboxStatus>>
> = {
  PROVISIONING: new Set(["READY", "FAILED", "DELETING"]),
  READY: new Set(["DELETING"]),
  FAILED: new Set(["DELETING"]),
  DELETING: new Set(["DELETED"]),
  DELETED: new Set(),
};

const sessionTransitions: Readonly<
  Record<SessionStatus, ReadonlySet<SessionStatus>>
> = {
  STARTING: new Set(["RUNNING", "SUCCEEDED", "FAILED"]),
  RUNNING: new Set(["SUCCEEDED", "FAILED"]),
  SUCCEEDED: new Set(),
  FAILED: new Set(),
};

export function isDevboxTransitionAllowed(
  from: DevboxStatus,
  to: DevboxStatus,
): boolean {
  return from === to || devboxTransitions[from].has(to);
}

export function isSessionTransitionAllowed(
  from: SessionStatus,
  to: SessionStatus,
): boolean {
  return from === to || sessionTransitions[from].has(to);
}
