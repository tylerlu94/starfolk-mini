import { open, rename, rm } from "node:fs/promises";

import type { z } from "zod";

import { RuntimeError } from "./errors.js";

export async function readBoundedJson<T>(
  input: NodeJS.ReadableStream,
  maximumBytes: number,
  schema: z.ZodType<T>,
): Promise<T> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  try {
    for await (const chunk of input) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      totalBytes += bytes.byteLength;
      if (totalBytes > maximumBytes) {
        throw new RuntimeError("INVALID_INPUT", "Standard input exceeds the size limit.");
      }
      chunks.push(bytes);
    }

    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new RuntimeError("INVALID_INPUT", "Standard input does not match the required JSON schema.");
    }
    return result.data;
  } catch (error: unknown) {
    if (error instanceof RuntimeError) {
      throw error;
    }
    throw new RuntimeError("INVALID_INPUT", "Standard input must contain one valid JSON object.");
  }
}

export async function writePrivateFile(
  path: string,
  contents: string,
  flag: "w" | "wx" = "wx",
): Promise<void> {
  const handle = await open(path, flag, 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(contents, { encoding: "utf8" });
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function writePrivateJsonAtomically(
  path: string,
  value: unknown,
): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await rm(temporaryPath, { force: true });
  await writePrivateFile(temporaryPath, `${JSON.stringify(value)}\n`);
  await rename(temporaryPath, path);
}
