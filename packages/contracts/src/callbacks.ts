import { z } from "zod";

import { IsoDateTimeSchema } from "./api.js";

export const DevboxStatusCallbackSchema = z.discriminatedUnion("status", [
  z
    .object({
      occurredAt: IsoDateTimeSchema,
      status: z.literal("READY"),
    })
    .strict(),
  z
    .object({
      occurredAt: IsoDateTimeSchema,
      reason: z.string().min(1),
      status: z.literal("FAILED"),
    })
    .strict(),
]);

export const SessionStatusCallbackSchema = z.discriminatedUnion("status", [
  z
    .object({
      occurredAt: IsoDateTimeSchema,
      status: z.literal("RUNNING"),
    })
    .strict(),
  z
    .object({
      exitCode: z.literal(0),
      occurredAt: IsoDateTimeSchema,
      status: z.literal("SUCCEEDED"),
    })
    .strict(),
  z
    .object({
      exitCode: z.number().int().nullable(),
      occurredAt: IsoDateTimeSchema,
      reason: z.string().min(1),
      status: z.literal("FAILED"),
    })
    .strict(),
]);

export type DevboxStatusCallback = z.infer<
  typeof DevboxStatusCallbackSchema
>;
export type SessionStatusCallback = z.infer<
  typeof SessionStatusCallbackSchema
>;
