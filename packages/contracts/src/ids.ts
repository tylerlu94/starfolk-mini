import { z } from "zod";

const uuidPattern =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export const EnvironmentIdSchema = z
  .string()
  .regex(new RegExp(`^env_${uuidPattern}$`, "i"));

export const DevboxIdSchema = z
  .string()
  .regex(new RegExp(`^devbox_${uuidPattern}$`, "i"));

export const SessionIdSchema = z
  .string()
  .regex(new RegExp(`^session_${uuidPattern}$`, "i"));

export type EnvironmentId = z.infer<typeof EnvironmentIdSchema>;
export type DevboxId = z.infer<typeof DevboxIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
