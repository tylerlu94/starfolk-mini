export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CliError";
  }
}

export function toCliError(error: unknown): CliError {
  if (error instanceof CliError) {
    return error;
  }
  return new CliError(
    "INTERNAL_ERROR",
    "The command failed unexpectedly. Re-run with the same arguments or contact the SFKM operator.",
    { cause: error },
  );
}
