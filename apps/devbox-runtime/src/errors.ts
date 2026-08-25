export class RuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "RuntimeError";
  }
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof RuntimeError) {
    return `${error.code}: ${error.message}`;
  }
  return "INTERNAL_ERROR: The devbox runtime command failed.";
}
