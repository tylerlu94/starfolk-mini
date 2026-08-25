import { randomUUID } from "node:crypto";

import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import pino, { type Logger } from "pino";
import { pinoHttp } from "pino-http";
import { z, ZodError, type ZodType } from "zod";

import {
  AuthorizeSshKeyRequestSchema,
  AuthorizeSshKeyResponseSchema,
  CreateDevboxRequestSchema,
  CreateDevboxResponseSchema,
  CreateSessionRequestSchema,
  CreateSessionResponseSchema,
  DevboxIdSchema,
  DevboxStatusCallbackSchema,
  ErrorEnvelopeSchema,
  GetDevboxResponseSchema,
  GetSessionResponseSchema,
  HealthResponseSchema,
  SessionIdSchema,
  SessionStatusCallbackSchema,
} from "@sfkm/contracts";

import type { ServerConfig } from "./config.js";
import type { Store } from "./db/types.js";
import { ApiError } from "./errors.js";
import { isBearerTokenAuthorized, readBearerToken } from "./security.js";
import type { BackendService } from "./service.js";

const idempotencyKeySchema = z.string().min(1).max(255);

export interface AppDependencies {
  readonly config: ServerConfig;
  readonly logger?: Logger;
  readonly runtimeArtifact: Buffer;
  readonly service: BackendService;
  readonly store: Store;
}

export function createApp(dependencies: AppDependencies): express.Express {
  const logger = dependencies.logger ?? createLogger();
  const app = express();
  app.disable("x-powered-by");
  app.use(
    pinoHttp({
      genReqId: (request) => request.headers["x-request-id"]?.toString() ?? randomUUID(),
      logger,
      redact: ["req.headers.authorization"],
    }),
  );
  app.use(express.json({ limit: "32kb", strict: true }));

  app.get("/artifacts/sfkm-devbox-runtime", (_request, response) => {
    response.set("Cache-Control", "no-store");
    response.type("application/octet-stream").send(dependencies.runtimeArtifact);
  });

  app.get("/health/live", (_request, response) => {
    response.json(validateOutput(HealthResponseSchema, { status: "ok" }));
  });
  app.get(
    "/health/ready",
    asyncRoute(async (_request, response) => {
      await dependencies.store.isReady();
      response.json(validateOutput(HealthResponseSchema, { status: "ok" }));
    }),
  );

  app.use("/v1", userAuthentication(dependencies.config));

  app.post(
    "/v1/devboxes",
    asyncRoute(async (request, response) => {
      const input = CreateDevboxRequestSchema.parse(request.body);
      const idempotencyKey = idempotencyKeySchema.parse(request.header("idempotency-key"));
      const devbox = await dependencies.service.createDevbox(input, idempotencyKey);
      response.status(202).json(validateOutput(CreateDevboxResponseSchema, devbox));
    }),
  );
  app.get(
    "/v1/devboxes/:id",
    asyncRoute(async (request, response) => {
      const id = DevboxIdSchema.parse(request.params.id);
      response.json(validateOutput(GetDevboxResponseSchema, await dependencies.service.getDevbox(id)));
    }),
  );
  app.delete(
    "/v1/devboxes/:id",
    asyncRoute(async (request, response) => {
      const id = DevboxIdSchema.parse(request.params.id);
      const result = await dependencies.service.deleteDevbox(id);
      response.status(result.status === "DELETED" ? 200 : 202).json(validateOutput(GetDevboxResponseSchema, result));
    }),
  );
  app.post(
    "/v1/devboxes/:id/ssh-authorization",
    asyncRoute(async (request, response) => {
      const id = DevboxIdSchema.parse(request.params.id);
      const input = AuthorizeSshKeyRequestSchema.parse(request.body);
      const result = await dependencies.service.authorizeSsh(id, input);
      response.json(validateOutput(AuthorizeSshKeyResponseSchema, result));
    }),
  );
  app.post(
    "/v1/sessions",
    asyncRoute(async (request, response) => {
      const input = CreateSessionRequestSchema.parse(request.body);
      const idempotencyKey = idempotencyKeySchema.parse(request.header("idempotency-key"));
      const session = await dependencies.service.createSession(input, idempotencyKey);
      response.status(201).json(validateOutput(CreateSessionResponseSchema, session));
    }),
  );
  app.get(
    "/v1/sessions/:id",
    asyncRoute(async (request, response) => {
      const id = SessionIdSchema.parse(request.params.id);
      response.json(validateOutput(GetSessionResponseSchema, await dependencies.service.getSession(id)));
    }),
  );

  app.post(
    "/v1/internal/devboxes/:id/status",
    asyncRoute(async (request, response) => {
      const id = DevboxIdSchema.parse(request.params.id);
      const callback = DevboxStatusCallbackSchema.parse(request.body);
      const result = await dependencies.service.updateDevboxStatus(
        id,
        readBearerToken(request.header("authorization")),
        callback,
      );
      response.json(validateOutput(GetDevboxResponseSchema, result));
    }),
  );
  app.post(
    "/v1/internal/sessions/:id/status",
    asyncRoute(async (request, response) => {
      const id = SessionIdSchema.parse(request.params.id);
      const callback = SessionStatusCallbackSchema.parse(request.body);
      const result = await dependencies.service.updateSessionStatus(
        id,
        readBearerToken(request.header("authorization")),
        callback,
      );
      response.json(validateOutput(GetSessionResponseSchema, result));
    }),
  );

  app.use((_request, _response, next) => {
    next(new ApiError(404, "INVALID_REQUEST", "Route was not found."));
  });
  app.use(errorHandler(logger));
  return app;
}

export function createLogger(): Logger {
  return pino({
    redact: {
      paths: [
        "req.headers.authorization",
        "headers.authorization",
        "apiToken",
        "bootstrapToken",
        "callbackToken",
        "prompt",
        "req.body.apiToken",
        "req.body.bootstrapToken",
        "req.body.callbackToken",
        "req.body.prompt",
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "SFKM_RESOURCE_TOKEN_KEY",
      ],
      censor: "[REDACTED]",
    },
  });
}

function userAuthentication(config: ServerConfig): RequestHandler {
  return (request, _response, next) => {
    if (request.path.startsWith("/internal/")) {
      next();
      return;
    }
    if (!isBearerTokenAuthorized(request.header("authorization"), config.apiTokenHash)) {
      next(new ApiError(401, "UNAUTHORIZED", "Bearer token is invalid."));
      return;
    }
    next();
  };
}

function asyncRoute(
  route: (request: Request, response: Response) => Promise<void>,
): RequestHandler {
  return (request, response, next) => {
    void route(request, response).catch(next);
  };
}

function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, request: Request, response: Response, _next: NextFunction) => {
    void _next;
    const requestId = request.id;
    if (error instanceof ApiError) {
      const envelope = {
        error: {
          code: error.code,
          ...(error.details === undefined ? {} : { details: error.details }),
          message: error.message,
          ...(requestId === undefined ? {} : { requestId }),
        },
      };
      response.status(error.status).json(ErrorEnvelopeSchema.parse(envelope));
      return;
    }
    if (error instanceof ZodError || isMalformedJson(error)) {
      const envelope = {
        error: {
          code: "INVALID_REQUEST" as const,
          message: "Request validation failed.",
          ...(requestId === undefined ? {} : { requestId }),
        },
      };
      response.status(400).json(ErrorEnvelopeSchema.parse(envelope));
      return;
    }
    logger.error({ err: error, requestId }, "Unhandled request error");
    const envelope = {
      error: {
        code: "INTERNAL_ERROR" as const,
        message: "An internal error occurred.",
        ...(requestId === undefined ? {} : { requestId }),
      },
    };
    response.status(500).json(ErrorEnvelopeSchema.parse(envelope));
  };
}

function isMalformedJson(error: unknown): boolean {
  return error instanceof SyntaxError && "status" in error && error.status === 400;
}

function validateOutput<Output>(schema: ZodType<Output>, value: unknown): Output {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error("Response contract validation failed.", { cause: result.error });
  }
  return result.data;
}
