import { z } from "zod";

import {
  DevboxIdSchema,
  RepositoryReferenceSchema,
  SessionIdSchema,
} from "@sfkm/contracts";

const boundedSecretSchema = z.string().min(32).max(4096);
const safeTextSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => !/[\0\r\n]/u.test(value), "control characters are not allowed");

export const CallbackUrlSchema = z
  .url()
  .max(2048)
  .superRefine((value, context) => {
    const parsed = new URL(value);
    if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
      context.addIssue({
        code: "custom",
        message: "credentials and fragments are not allowed",
      });
    }

    if (parsed.protocol === "https:") {
      return;
    }

    const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
    if (parsed.protocol !== "http:" || !loopbackHosts.has(parsed.hostname)) {
      context.addIssue({
        code: "custom",
        message: "callbacks must use HTTPS (HTTP is limited to loopback tests)",
      });
    }
  });

const repositoryUrlSchema = RepositoryReferenceSchema.shape.url.superRefine(
  (value, context) => {
    const parsed = new URL(value);
    if (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    ) {
      context.addIssue({
        code: "custom",
        message: "repository URLs cannot contain credentials, queries, or fragments",
      });
    }
  },
);

const repositorySchema = RepositoryReferenceSchema.extend({
  branch: safeTextSchema.refine(
    (value) =>
      /^[a-z0-9][a-z0-9._/-]{0,254}$/iu.test(value) &&
      !value.startsWith("-") &&
      !value.startsWith("/") &&
      !value.endsWith("/") &&
      !value.endsWith(".") &&
      !value.endsWith(".lock") &&
      !value.includes("..") &&
      !value.includes("@{") &&
      !/[ ~^:?*[\\]/u.test(value),
    "branch is not a safe Git ref name",
  ),
  url: repositoryUrlSchema,
});

export const BootstrapInputSchema = z
  .object({
    bootstrapToken: boundedSecretSchema,
    callbackUrl: CallbackUrlSchema,
    devboxId: DevboxIdSchema,
    repository: repositorySchema,
    setupCommand: safeTextSchema,
  })
  .strict();

export const SessionStartInputSchema = z
  .object({
    callbackToken: boundedSecretSchema,
    prompt: z.string().min(1).max(256 * 1024),
  })
  .strict();

export const LocalSessionStatusSchema = z.enum([
  "MISSING",
  "STARTING",
  "RUNNING",
  "SUCCEEDED",
  "FAILED",
  "UNRECOVERABLE",
]);

export const StoredSessionSchema = z
  .object({
    callbackUrl: CallbackUrlSchema,
    createdAt: z.string().datetime({ offset: true }),
    exitCode: z.number().int().nullable(),
    failureReason: z.string().min(1).nullable(),
    pid: z.number().int().positive().nullable(),
    sessionId: SessionIdSchema,
    status: z.enum(["STARTING", "RUNNING", "SUCCEEDED", "FAILED"]),
    tmuxName: z.string().regex(/^sfkm-[0-9a-f-]+$/u),
    updatedAt: z.string().datetime({ offset: true }),
    version: z.literal(1),
  })
  .strict();

export const SessionIdArgumentSchema = SessionIdSchema;

export type BootstrapInput = z.infer<typeof BootstrapInputSchema>;
export type LocalSessionStatus = z.infer<typeof LocalSessionStatusSchema>;
export type SessionStartInput = z.infer<typeof SessionStartInputSchema>;
export type StoredSession = z.infer<typeof StoredSessionSchema>;
