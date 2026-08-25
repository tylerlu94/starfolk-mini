import { join } from "node:path";

import { SessionIdArgumentSchema } from "../schemas.js";

export interface SessionPaths {
  readonly callbackToken: string;
  readonly directory: string;
  readonly exitCode: string;
  readonly pid: string;
  readonly prompt: string;
  readonly state: string;
}

export function sessionPaths(root: string, sessionId: string): SessionPaths {
  const validated = SessionIdArgumentSchema.parse(sessionId).toLowerCase();
  const directory = join(root, validated);
  return {
    callbackToken: join(directory, "callback-token"),
    directory,
    exitCode: join(directory, "exit-code"),
    pid: join(directory, "agent-pid"),
    prompt: join(directory, "prompt"),
    state: join(directory, "state.json"),
  };
}
