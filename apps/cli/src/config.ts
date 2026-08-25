import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

import { CliError } from "./errors.js";

export const HOSTED_API_URL = "https://sfkm-backend-production.up.railway.app";
export const CONFIG_MAX_BYTES = 16 * 1024;

const ConfigFileSchema = z
  .object({
    apiToken: z.string().min(1).max(8 * 1024),
  })
  .strict();

export interface CliConfig {
  readonly apiToken: string;
  readonly apiUrl: string;
}

export interface ConfigDependencies {
  readonly configPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export async function loadConfig(
  dependencies: ConfigDependencies = {},
): Promise<CliConfig> {
  const configPath =
    dependencies.configPath ?? join(homedir(), ".config", "sfkm", "config.json");
  let metadata;
  try {
    metadata = await lstat(configPath);
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      throw new CliError(
        "CONFIG_NOT_FOUND",
        `SFKM configuration is missing. Create ${configPath} with mode 0600 and an apiToken field.`,
      );
    }
    throw new CliError("CONFIG_UNREADABLE", `Unable to inspect ${configPath}.`, {
      cause: error,
    });
  }

  if (!metadata.isFile()) {
    throw new CliError("CONFIG_UNSAFE", `${configPath} must be a regular file.`);
  }
  if (process.getuid !== undefined && metadata.uid !== process.getuid()) {
    throw new CliError("CONFIG_UNSAFE", `${configPath} must be owned by the current user.`);
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new CliError(
      "CONFIG_UNSAFE",
      `${configPath} is accessible by other users. Run: chmod 600 ${configPath}`,
    );
  }
  if (metadata.size > CONFIG_MAX_BYTES) {
    throw new CliError("CONFIG_INVALID", `${configPath} is unexpectedly large.`);
  }

  let value: unknown;
  try {
    value = JSON.parse(await readFile(configPath, "utf8")) as unknown;
  } catch (error: unknown) {
    throw new CliError("CONFIG_INVALID", `${configPath} must contain valid JSON.`, {
      cause: error,
    });
  }
  const parsed = ConfigFileSchema.safeParse(value);
  if (!parsed.success) {
    throw new CliError(
      "CONFIG_INVALID",
      `${configPath} must contain exactly one non-empty apiToken string.`,
    );
  }

  const environment = dependencies.environment ?? process.env;
  const apiUrl = normalizeApiUrl(environment.SFKM_API_URL ?? HOSTED_API_URL);
  return { apiToken: parsed.data.apiToken, apiUrl };
}

export function normalizeApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    throw new CliError("CONFIG_INVALID", "SFKM_API_URL must be a valid HTTP(S) URL.", {
      cause: error,
    });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new CliError("CONFIG_INVALID", "SFKM_API_URL must use HTTP or HTTPS.");
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new CliError(
      "CONFIG_INVALID",
      "SFKM_API_URL must not contain credentials, a query, or a fragment.",
    );
  }
  return url.toString().replace(/\/$/, "");
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
