import { z } from "zod";

import { DevboxIdSchema, EnvironmentIdSchema, SessionIdSchema } from "./ids.js";
import { DevboxStatusSchema, SessionStatusSchema } from "./states.js";

export const IsoDateTimeSchema = z.string().datetime({ offset: true });

export const HealthResponseSchema = z
  .object({
    status: z.literal("ok"),
  })
  .strict();

export const RepositoryReferenceSchema = z
  .object({
    branch: z.string().min(1),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/i),
    url: z.url().startsWith("https://"),
  })
  .strict();

export const CreateDevboxRequestSchema = z
  .object({
    repository: RepositoryReferenceSchema,
  })
  .strict();

export const DevboxSchema = z
  .object({
    createdAt: IsoDateTimeSchema,
    environmentId: EnvironmentIdSchema,
    id: DevboxIdSchema,
    publicHostname: z.string().min(1).nullable(),
    readyAt: IsoDateTimeSchema.nullable(),
    repository: RepositoryReferenceSchema,
    status: DevboxStatusSchema,
    statusReason: z.string().nullable(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const CreateDevboxResponseSchema = DevboxSchema;
export const GetDevboxResponseSchema = DevboxSchema;

export const AuthorizeSshKeyRequestSchema = z
  .object({
    publicKey: z.string().startsWith("ssh-ed25519 ").min(80),
  })
  .strict();

export const AuthorizeSshKeyResponseSchema = z
  .object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65_535),
    username: z.string().min(1),
  })
  .strict();

export const CreateSessionRequestSchema = z
  .object({
    devboxId: DevboxIdSchema,
  })
  .strict();

export const CreateSessionResponseSchema = z
  .object({
    callbackToken: z.string().min(32),
    callbackUrl: z.url().startsWith("https://"),
    devboxId: DevboxIdSchema,
    id: SessionIdSchema,
    status: z.literal("STARTING"),
  })
  .strict();

export const SessionSchema = z
  .object({
    agent: z.string().min(1),
    createdAt: IsoDateTimeSchema,
    devboxId: DevboxIdSchema,
    exitCode: z.number().int().nullable(),
    finishedAt: IsoDateTimeSchema.nullable(),
    id: SessionIdSchema,
    model: z.string().min(1),
    startedAt: IsoDateTimeSchema.nullable(),
    status: SessionStatusSchema,
    statusReason: z.string().nullable(),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();

export const GetSessionResponseSchema = SessionSchema;

export type RepositoryReference = z.infer<typeof RepositoryReferenceSchema>;
export type CreateDevboxRequest = z.infer<typeof CreateDevboxRequestSchema>;
export type Devbox = z.infer<typeof DevboxSchema>;
export type AuthorizeSshKeyRequest = z.infer<
  typeof AuthorizeSshKeyRequestSchema
>;
export type AuthorizeSshKeyResponse = z.infer<
  typeof AuthorizeSshKeyResponseSchema
>;
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;
export type Session = z.infer<typeof SessionSchema>;
