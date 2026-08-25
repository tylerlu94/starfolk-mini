import {
  AuthorizeSshKeyResponseSchema,
  CreateDevboxResponseSchema,
  CreateSessionResponseSchema,
  ErrorEnvelopeSchema,
  GetDevboxResponseSchema,
  GetSessionResponseSchema,
  type AuthorizeSshKeyResponse,
  type CreateDevboxRequest,
  type CreateSessionResponse,
  type Devbox,
  type Session,
} from "@sfkm/contracts";
import type { z } from "zod";

import { CliError } from "./errors.js";

export const MAX_API_RESPONSE_BYTES = 256 * 1024;
export const API_REQUEST_TIMEOUT_MS = 30_000;

export type ApiTransport = (url: string, init: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  readonly retryDelay?: (attempt: number) => Promise<void>;
  readonly transport?: ApiTransport;
}

export class ApiClient {
  private readonly retryDelay: (attempt: number) => Promise<void>;
  private readonly transport: ApiTransport;

  constructor(
    private readonly baseUrl: string,
    private readonly apiToken: string,
    options: ApiClientOptions = {},
  ) {
    this.transport = options.transport ?? fetch;
    this.retryDelay =
      options.retryDelay ??
      ((attempt) => new Promise((resolve) => setTimeout(resolve, 250 * 2 ** (attempt - 1))));
  }

  createDevbox(request: CreateDevboxRequest, idempotencyKey: string): Promise<Devbox> {
    return this.request(
      "/v1/devboxes",
      CreateDevboxResponseSchema,
      {
        body: JSON.stringify(request),
        headers: { "Idempotency-Key": idempotencyKey },
        method: "POST",
      },
      3,
    );
  }

  getDevbox(id: string): Promise<Devbox> {
    return this.request(`/v1/devboxes/${encodeURIComponent(id)}`, GetDevboxResponseSchema, {
      method: "GET",
    });
  }

  deleteDevbox(id: string): Promise<Devbox> {
    return this.request(`/v1/devboxes/${encodeURIComponent(id)}`, GetDevboxResponseSchema, {
      method: "DELETE",
    });
  }

  authorizeSsh(id: string, publicKey: string): Promise<AuthorizeSshKeyResponse> {
    return this.request(
      `/v1/devboxes/${encodeURIComponent(id)}/ssh-authorization`,
      AuthorizeSshKeyResponseSchema,
      { body: JSON.stringify({ publicKey }), method: "POST" },
    );
  }

  createSession(devboxId: string, idempotencyKey: string): Promise<CreateSessionResponse> {
    return this.request(
      "/v1/sessions",
      CreateSessionResponseSchema,
      {
        body: JSON.stringify({ devboxId }),
        headers: { "Idempotency-Key": idempotencyKey },
        method: "POST",
      },
      3,
    );
  }

  getSession(id: string): Promise<Session> {
    return this.request(`/v1/sessions/${encodeURIComponent(id)}`, GetSessionResponseSchema, {
      method: "GET",
    });
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit,
    attempts = 1,
  ): Promise<T> {
    let lastFailure: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.transport(`${this.baseUrl}${path}`, {
          ...init,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${this.apiToken}`,
            ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
            ...init.headers,
          },
          signal: init.signal ?? AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
        });
      } catch (error: unknown) {
        lastFailure = error;
        if (attempt < attempts) {
          await this.retryDelay(attempt);
          continue;
        }
        throw new CliError(
          "API_UNAVAILABLE",
          "Unable to reach the SFKM API. Check your connection and SFKM_API_URL.",
          { cause: error },
        );
      }

      const body = await readBoundedResponse(response);
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        if (retryable && attempt < attempts) {
          await this.retryDelay(attempt);
          continue;
        }
        throw parseApiError(response.status, body, this.apiToken);
      }

      let json: unknown;
      try {
        json = JSON.parse(body) as unknown;
      } catch (error: unknown) {
        throw new CliError(
          "INVALID_API_RESPONSE",
          "The SFKM API returned malformed JSON.",
          { cause: error },
        );
      }
      const parsed = schema.safeParse(json);
      if (!parsed.success) {
        throw new CliError(
          "INVALID_API_RESPONSE",
          "The SFKM API returned a response that does not match the frozen contract.",
        );
      }
      return parsed.data;
    }
    throw new CliError("API_UNAVAILABLE", "Unable to reach the SFKM API.", {
      cause: lastFailure,
    });
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_API_RESPONSE_BYTES) {
    throw new CliError("INVALID_API_RESPONSE", "The SFKM API response is too large.");
  }
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    bytes += value.byteLength;
    if (bytes > MAX_API_RESPONSE_BYTES) {
      await reader.cancel();
      throw new CliError("INVALID_API_RESPONSE", "The SFKM API response is too large.");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(combined);
  } catch (error: unknown) {
    throw new CliError("INVALID_API_RESPONSE", "The SFKM API response is not valid UTF-8.", {
      cause: error,
    });
  }
}

function parseApiError(status: number, body: string, apiToken: string): CliError {
  try {
    const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(body) as unknown);
    if (parsed.success) {
      const message = sanitizeMessage(parsed.data.error.message, apiToken);
      return new CliError(parsed.data.error.code, message);
    }
  } catch {
    // The generic message below deliberately does not echo an untrusted body.
  }
  return new CliError(
    "INVALID_API_RESPONSE",
    `The SFKM API returned HTTP ${status} without a valid error envelope.`,
  );
}

function sanitizeMessage(value: string, apiToken: string): string {
  return [...value.replaceAll(apiToken, "[REDACTED]")]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127) ? " " : character;
    })
    .join("")
    .slice(0, 1_000);
}
