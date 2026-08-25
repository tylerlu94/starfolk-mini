import { describe, expect, it } from "vitest";

import { ApiClient, MAX_API_RESPONSE_BYTES, type ApiTransport } from "./api-client.js";

const ids = {
  devbox: "devbox_2f1c9de0-f296-4e5d-9aaa-92d945e94ea2",
  environment: "env_2f1c9de0-f296-4e5d-9aaa-92d945e94ea2",
  session: "session_2f1c9de0-f296-4e5d-9aaa-92d945e94ea2",
};
const now = "2026-08-23T12:00:00.000Z";

describe("ApiClient", () => {
  it("reuses the exact idempotency key and body across transient retries", async () => {
    const requests: RequestInit[] = [];
    let attempt = 0;
    const transport: ApiTransport = async (_url, init) => {
      requests.push(init);
      attempt += 1;
      if (attempt === 1) {
        throw new Error("uncertain network outcome");
      }
      if (attempt === 2) {
        return jsonResponse({ error: { code: "INTERNAL_ERROR", message: "retry" } }, 503);
      }
      return jsonResponse(devbox("PROVISIONING"), 202);
    };
    const client = new ApiClient("https://api.example.com", "bearer-secret", {
      retryDelay: async () => undefined,
      transport,
    });
    const request = {
      repository: {
        branch: "main",
        commitSha: "1234567890abcdef1234567890abcdef12345678",
        url: "https://github.com/openai/example.git",
      },
    };

    await expect(client.createDevbox(request, "same-key")).resolves.toMatchObject({ id: ids.devbox });
    expect(requests).toHaveLength(3);
    expect(requests.map((item) => new Headers(item.headers).get("idempotency-key"))).toEqual([
      "same-key",
      "same-key",
      "same-key",
    ]);
    expect(requests.map((item) => item.body)).toEqual([
      JSON.stringify(request),
      JSON.stringify(request),
      JSON.stringify(request),
    ]);
  });

  it("also reuses the session idempotency key after an uncertain outcome", async () => {
    const keys: Array<string | null> = [];
    let attempt = 0;
    const client = new ApiClient("https://api.example.com", "secret", {
      retryDelay: async () => undefined,
      transport: async (_url, init) => {
        keys.push(new Headers(init.headers).get("idempotency-key"));
        attempt += 1;
        if (attempt === 1) throw new Error("connection reset after write");
        return jsonResponse({
          callbackToken: "t".repeat(32),
          callbackUrl: `https://api.example.com/v1/internal/sessions/${ids.session}/status`,
          devboxId: ids.devbox,
          id: ids.session,
          status: "STARTING",
        }, 201);
      },
    });

    await expect(client.createSession(ids.devbox, "session-key")).resolves.toMatchObject({
      id: ids.session,
    });
    expect(keys).toEqual(["session-key", "session-key"]);
  });

  it("validates hostile or malformed success responses", async () => {
    const extraField = new ApiClient("https://api.example.com", "secret", {
      transport: async () => jsonResponse({ ...devbox("READY"), callbackToken: "leak" }),
    });
    await expect(extraField.getDevbox(ids.devbox)).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
    });

    const malformed = new ApiClient("https://api.example.com", "secret", {
      transport: async () => new Response("not-json"),
    });
    await expect(malformed.getDevbox(ids.devbox)).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
    });
  });

  it("bounds API responses before parsing", async () => {
    const client = new ApiClient("https://api.example.com", "secret", {
      transport: async () => new Response("x".repeat(MAX_API_RESPONSE_BYTES + 1)),
    });
    await expect(client.getDevbox(ids.devbox)).rejects.toMatchObject({
      code: "INVALID_API_RESPONSE",
    });
  });

  it("uses the stable error envelope without echoing hostile bodies", async () => {
    const stable = new ApiClient("https://api.example.com", "secret", {
      transport: async () =>
        jsonResponse({ error: { code: "DEVBOX_NOT_FOUND", message: "Devbox was not found." } }, 404),
    });
    await expect(stable.getDevbox(ids.devbox)).rejects.toMatchObject({
      code: "DEVBOX_NOT_FOUND",
      message: "Devbox was not found.",
    });

    const hostile = new ApiClient("https://api.example.com", "secret", {
      transport: async () => new Response("callback-token-value", { status: 500 }),
    });
    await expect(hostile.getDevbox(ids.devbox)).rejects.not.toThrow(/callback-token-value/u);
  });

  it("redacts the configured bearer token from an error-envelope message", async () => {
    const client = new ApiClient("https://api.example.com", "bearer-secret", {
      transport: async () =>
        jsonResponse(
          { error: { code: "INTERNAL_ERROR", message: "bad bearer-secret value" } },
          400,
        ),
    });
    await expect(client.getDevbox(ids.devbox)).rejects.toMatchObject({
      message: "bad [REDACTED] value",
    });
  });
});

function devbox(status: "PROVISIONING" | "READY") {
  return {
    createdAt: now,
    environmentId: ids.environment,
    id: ids.devbox,
    publicHostname: status === "READY" ? "host.example.com" : null,
    readyAt: status === "READY" ? now : null,
    repository: {
      branch: "main",
      commitSha: "1234567890abcdef1234567890abcdef12345678",
      url: "https://github.com/openai/example.git",
    },
    status,
    statusReason: null,
    updatedAt: now,
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status,
  });
}
