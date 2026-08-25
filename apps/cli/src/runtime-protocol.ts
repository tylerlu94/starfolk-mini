import { z } from "zod";

import { SessionIdSchema } from "@sfkm/contracts";

import { CliError } from "./errors.js";

const RuntimeSessionResponseSchema = z
  .object({
    exitCode: z.number().int().nullable(),
    pid: z.number().int().positive().nullable(),
    recoverable: z.boolean(),
    sessionId: SessionIdSchema,
    status: z.enum([
      "MISSING",
      "STARTING",
      "RUNNING",
      "SUCCEEDED",
      "FAILED",
      "UNRECOVERABLE",
    ]),
    tmuxExists: z.boolean(),
    tmuxName: z.string().regex(/^sfkm-[0-9a-f-]+$/u),
  })
  .strict();

export type RuntimeSessionResponse = z.infer<typeof RuntimeSessionResponseSchema>;

export function parseRuntimeStartResponse(value: string): RuntimeSessionResponse {
  return parseJson(value, RuntimeSessionResponseSchema, "start");
}

export function parseRuntimeInspectResponse(value: string): RuntimeSessionResponse {
  return parseJson(value, RuntimeSessionResponseSchema, "inspect");
}

function parseJson<T>(value: string, schema: z.ZodType<T>, operation: string): T {
  let json: unknown;
  try {
    json = JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new CliError(
      "INVALID_RUNTIME_RESPONSE",
      `The devbox runtime returned malformed JSON for session ${operation}.`,
      { cause: error },
    );
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new CliError(
      "INVALID_RUNTIME_RESPONSE",
      `The devbox runtime returned an invalid session ${operation} response.`,
    );
  }
  return parsed.data;
}
