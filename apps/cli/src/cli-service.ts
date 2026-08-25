import { randomUUID } from "node:crypto";

import {
  DevboxIdSchema,
  SessionIdSchema,
  type AuthorizeSshKeyResponse,
  type CreateDevboxRequest,
  type CreateSessionResponse,
  type Devbox,
  type Session,
} from "@sfkm/contracts";

import { CliError } from "./errors.js";
import { preflightRepository } from "./git/preflight.js";
import type { ProcessRunner } from "./process-runner.js";
import {
  parseRuntimeInspectResponse,
  parseRuntimeStartResponse,
  type RuntimeSessionResponse,
} from "./runtime-protocol.js";
import { runSsh } from "./ssh/connection.js";
import {
  withTemporarySshIdentity,
  type TemporaryIdentityOptions,
} from "./ssh/identity.js";

export const MAX_PROMPT_BYTES = 32 * 1024;
const SAFE_CALLBACK_URL_PATTERN =
  /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]{1,5})?\/[A-Za-z0-9._~/-]+$/u;

export interface CliOutput {
  readonly stderr: (line: string) => void;
  readonly stdout: (line: string) => void;
}

export interface CliApi {
  authorizeSsh(id: string, publicKey: string): Promise<AuthorizeSshKeyResponse>;
  createDevbox(request: CreateDevboxRequest, idempotencyKey: string): Promise<Devbox>;
  createSession(devboxId: string, idempotencyKey: string): Promise<CreateSessionResponse>;
  deleteDevbox(id: string): Promise<Devbox>;
  getDevbox(id: string): Promise<Devbox>;
  getSession(id: string): Promise<Session>;
}

export interface CliServiceOptions {
  readonly identity?: TemporaryIdentityOptions;
  readonly output?: CliOutput;
  readonly pollAttempts?: number;
  readonly pollDelay?: () => Promise<void>;
  readonly randomId?: () => string;
}

export class CliService {
  private readonly identity: TemporaryIdentityOptions;
  private readonly output: CliOutput;
  private readonly pollAttempts: number;
  private readonly pollDelay: () => Promise<void>;
  private readonly randomId: () => string;

  constructor(
    private readonly api: CliApi,
    private readonly runner: ProcessRunner,
    options: CliServiceOptions = {},
  ) {
    this.identity = options.identity ?? {};
    this.output =
      options.output ??
      ({
        stderr: (line) => process.stderr.write(`${line}\n`),
        stdout: (line) => process.stdout.write(`${line}\n`),
      } satisfies CliOutput);
    this.pollAttempts = options.pollAttempts ?? 900;
    this.pollDelay =
      options.pollDelay ?? (() => new Promise((resolve) => setTimeout(resolve, 2_000)));
    this.randomId = options.randomId ?? randomUUID;
  }

  async createDevbox(repositoryUrl: string, branch: string): Promise<void> {
    const repository = await preflightRepository(this.runner, repositoryUrl, branch);
    const idempotencyKey = this.randomId();
    const created = await this.api.createDevbox({ repository }, idempotencyKey);
    this.output.stdout(created.id);
    const ready = await this.pollDevbox(created, "create");
    this.output.stderr(`Devbox ${ready.id} is READY.`);
  }

  async deleteDevbox(rawId: string): Promise<void> {
    const id = parseDevboxId(rawId);
    const deletion = await this.api.deleteDevbox(id);
    const deleted = await this.pollDevbox(deletion, "delete");
    this.output.stdout(deleted.id);
    this.output.stderr(`Devbox ${deleted.id} is DELETED.`);
  }

  async ssh(rawId: string): Promise<void> {
    const id = parseDevboxId(rawId);
    await withTemporarySshIdentity(
      this.runner,
      async (identity) => {
        const authorization = await this.api.authorizeSsh(id, identity.publicKey);
        const result = await runSsh(this.runner, identity, authorization, {
          interactive: true,
          remoteArguments: ["cd /workspace/repo && exec $SHELL -l"],
        });
        if (result.exitCode !== 0) {
          throw new CliError("SSH_FAILED", "The SSH connection ended unsuccessfully.");
        }
      },
      this.identity,
    );
  }

  async startSession(rawDevboxId: string, prompt: string): Promise<void> {
    const devboxId = parseDevboxId(rawDevboxId);
    validatePrompt(prompt);
    const session = await this.api.createSession(devboxId, this.randomId());
    validateSafeCallbackUrl(session.callbackUrl);
    this.output.stdout(session.id);

    await withTemporarySshIdentity(
      this.runner,
      async (identity) => {
        const startAuthorization = await this.api.authorizeSsh(devboxId, identity.publicKey);
        const start = await runSsh(this.runner, identity, startAuthorization, {
          interactive: false,
          remoteArguments: [
            "sfkm-devbox-runtime",
            "session",
            "start",
            session.id,
            "--callback-url",
            session.callbackUrl,
          ],
          stdin: JSON.stringify({ callbackToken: session.callbackToken, prompt }),
        });
        if (start.exitCode !== 0) {
          throw new CliError(
            "SESSION_START_FAILED",
            "The devbox runtime could not start the session.",
          );
        }
        const runtimeState = parseRuntimeStartResponse(start.stdout);
        validateRuntimeSessionIdentity(runtimeState, session.id);
        if (runtimeState.status === "SUCCEEDED" || runtimeState.status === "FAILED") {
          this.printTerminalSession(session.id, runtimeState.status, runtimeState.exitCode);
          return;
        }
        if (
          (runtimeState.status !== "STARTING" && runtimeState.status !== "RUNNING") ||
          !runtimeState.recoverable ||
          !runtimeState.tmuxExists
        ) {
          throw new CliError(
            "SESSION_START_FAILED",
            "The runtime did not retain an attachable session after start.",
          );
        }

        this.printAttachInstructions(session.id);
        const attachAuthorization = await this.api.authorizeSsh(devboxId, identity.publicKey);
        const attach = await runSsh(this.runner, identity, attachAuthorization, {
          interactive: true,
          remoteArguments: [
            "sfkm-devbox-runtime",
            "session",
            "attach",
            session.id,
          ],
        });
        if (attach.exitCode !== 0) {
          throw new CliError("SESSION_ATTACH_FAILED", "The session attachment ended unsuccessfully.");
        }
        await this.printAttachmentResult(session.id);
      },
      this.identity,
    );
  }

  async connectSession(rawSessionId: string): Promise<void> {
    const sessionId = parseSessionId(rawSessionId);
    const session = await this.api.getSession(sessionId);
    if (session.status === "SUCCEEDED" || session.status === "FAILED") {
      this.printTerminalSession(session.id, session.status, session.exitCode);
      return;
    }

    await withTemporarySshIdentity(
      this.runner,
      async (identity) => {
        const inspectAuthorization = await this.api.authorizeSsh(
          session.devboxId,
          identity.publicKey,
        );
        const inspect = await runSsh(this.runner, identity, inspectAuthorization, {
          interactive: false,
          remoteArguments: [
            "sfkm-devbox-runtime",
            "session",
            "inspect",
            session.id,
          ],
        });
        if (inspect.exitCode !== 0) {
          throw new CliError(
            "SESSION_NOT_RECOVERABLE",
            "The devbox runtime could not inspect the original session.",
          );
        }
        const runtimeState = parseRuntimeInspectResponse(inspect.stdout);
        validateRuntimeSessionIdentity(runtimeState, session.id);
        if (
          runtimeState.status === "MISSING" ||
          runtimeState.status === "UNRECOVERABLE" ||
          ((runtimeState.status === "STARTING" || runtimeState.status === "RUNNING") &&
            (!runtimeState.recoverable || !runtimeState.tmuxExists))
        ) {
          throw new CliError(
            "SESSION_NOT_RECOVERABLE",
            "The original agent process is missing or cannot be recovered on this devbox.",
          );
        }
        if (runtimeState.status === "SUCCEEDED" || runtimeState.status === "FAILED") {
          this.printTerminalSession(session.id, runtimeState.status, runtimeState.exitCode);
          return;
        }

        this.printAttachInstructions(session.id);
        const attachAuthorization = await this.api.authorizeSsh(
          session.devboxId,
          identity.publicKey,
        );
        const attach = await runSsh(this.runner, identity, attachAuthorization, {
          interactive: true,
          remoteArguments: [
            "sfkm-devbox-runtime",
            "session",
            "attach",
            session.id,
          ],
        });
        if (attach.exitCode !== 0) {
          throw new CliError("SESSION_ATTACH_FAILED", "The session attachment ended unsuccessfully.");
        }
        await this.printAttachmentResult(session.id);
      },
      this.identity,
    );
  }

  private async pollDevbox(initial: Devbox, operation: "create" | "delete"): Promise<Devbox> {
    let current = initial;
    let lastPrintedStatus: string | undefined;
    for (let attempt = 0; attempt < this.pollAttempts; attempt += 1) {
      if (current.status !== lastPrintedStatus) {
        this.output.stderr(`Devbox ${current.id}: ${current.status}`);
        lastPrintedStatus = current.status;
      }
      if (operation === "create") {
        if (current.status === "READY") {
          return current;
        }
        if (current.status === "FAILED" || current.status === "DELETED") {
          throw new CliError(
            "BOOTSTRAP_FAILED",
            `Devbox creation failed${formatReason(current.statusReason)}.`,
          );
        }
      } else if (current.status === "DELETED") {
        return current;
      }
      await this.pollDelay();
      current = await this.api.getDevbox(current.id);
    }
    throw new CliError(
      "POLL_TIMEOUT",
      `Timed out waiting for devbox ${current.id} to finish ${operation === "create" ? "provisioning" : "deletion"}.`,
    );
  }

  private printTerminalSession(
    id: string,
    status: "SUCCEEDED" | "FAILED",
    exitCode: number | null,
  ): void {
    this.output.stdout(
      `Session ${id}: ${status} (exit code ${exitCode === null ? "unknown" : exitCode.toString(10)})`,
    );
  }

  private printAttachInstructions(id: string): void {
    this.output.stderr(`Attaching to ${id}.`);
    this.output.stderr("Detach: Ctrl-b, then d");
    this.output.stderr(`Reconnect: sfkm session connect ${id}`);
  }

  private async printAttachmentResult(id: string): Promise<void> {
    try {
      const session = await this.api.getSession(id);
      if (session.status === "SUCCEEDED" || session.status === "FAILED") {
        this.printTerminalSession(id, session.status, session.exitCode);
        return;
      }
    } catch {
      // The SSH attachment already ended successfully. A transient API failure
      // should not prevent the CLI from showing the recovery command.
    }
    this.output.stderr(`Detached from ${id}.`);
    this.output.stderr(`Reconnect: sfkm session connect ${id}`);
  }
}

function parseDevboxId(value: string): string {
  const parsed = DevboxIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliError("INVALID_REQUEST", "Devbox ID is invalid; expected devbox_<uuid>.");
  }
  return parsed.data;
}

function parseSessionId(value: string): string {
  const parsed = SessionIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliError("INVALID_REQUEST", "Session ID is invalid; expected session_<uuid>.");
  }
  return parsed.data;
}

function validatePrompt(prompt: string): void {
  const bytes = Buffer.byteLength(prompt, "utf8");
  if (bytes === 0 || bytes > MAX_PROMPT_BYTES) {
    throw new CliError(
      "INVALID_REQUEST",
      `Prompt must contain between 1 and ${MAX_PROMPT_BYTES.toString(10)} UTF-8 bytes.`,
    );
  }
}

function validateSafeCallbackUrl(url: string): void {
  if (!SAFE_CALLBACK_URL_PATTERN.test(url)) {
    throw new CliError(
      "INVALID_API_RESPONSE",
      "The API returned a callback URL that is unsafe for the fixed runtime command.",
    );
  }
}

function validateRuntimeSessionIdentity(
  response: RuntimeSessionResponse,
  expectedSessionId: string,
): void {
  if (response.sessionId.toLowerCase() !== expectedSessionId.toLowerCase()) {
    throw new CliError(
      "INVALID_RUNTIME_RESPONSE",
      "The devbox runtime response belongs to a different session.",
    );
  }
}

function formatReason(reason: string | null): string {
  if (reason === null || reason === "") {
    return "";
  }
  const sanitized = [...reason]
    .map((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127) ? " " : character;
    })
    .join("")
    .slice(0, 500);
  return `: ${sanitized}`;
}
