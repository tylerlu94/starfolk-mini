import { SessionIdArgumentSchema } from "../schemas.js";

export function deterministicTmuxName(sessionId: string): string {
  const validated = SessionIdArgumentSchema.parse(sessionId).toLowerCase();
  return `sfkm-${validated.slice("session_".length)}`;
}
