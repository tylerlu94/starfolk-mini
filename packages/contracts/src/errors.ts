import { z } from "zod";

export const ErrorCodeSchema = z.enum([
  "UNAUTHORIZED",
  "INVALID_REQUEST",
  "REPO_NOT_PUSHED",
  "DEVBOX_NOT_READY",
  "DEVBOX_NOT_FOUND",
  "SSH_AUTHORIZATION_FAILED",
  "BOOTSTRAP_FAILED",
  "SESSION_START_FAILED",
  "SESSION_NOT_FOUND",
  "SESSION_NOT_RECOVERABLE",
  "IDEMPOTENCY_CONFLICT",
  "AWS_CAPACITY_UNAVAILABLE",
  "INTERNAL_ERROR",
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const ErrorEnvelopeSchema = z
  .object({
    error: z
      .object({
        code: ErrorCodeSchema,
        details: z.record(z.string(), z.unknown()).optional(),
        message: z.string().min(1),
        requestId: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
