import {
  DevboxStatusCallbackSchema,
  SessionStatusCallbackSchema,
} from "@sfkm/contracts";

import { RuntimeError } from "./errors.js";

import type {
  DevboxStatusCallback,
  SessionStatusCallback,
} from "@sfkm/contracts";

export interface CallbackClient {
  postDevboxStatus(
    url: string,
    token: string,
    payload: DevboxStatusCallback,
  ): Promise<void>;
  postSessionStatus(
    url: string,
    token: string,
    payload: SessionStatusCallback,
  ): Promise<void>;
}

export class HttpCallbackClient implements CallbackClient {
  constructor(private readonly fetchImplementation: typeof fetch = fetch) {}

  async postDevboxStatus(
    url: string,
    token: string,
    payload: DevboxStatusCallback,
  ): Promise<void> {
    await this.post(url, token, DevboxStatusCallbackSchema.parse(payload));
  }

  async postSessionStatus(
    url: string,
    token: string,
    payload: SessionStatusCallback,
  ): Promise<void> {
    await this.post(url, token, SessionStatusCallbackSchema.parse(payload));
  }

  private async post(url: string, token: string, payload: unknown): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        body: JSON.stringify(payload),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new RuntimeError("CALLBACK_FAILED", "The lifecycle callback could not be delivered.");
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw new RuntimeError("CALLBACK_FAILED", "The lifecycle callback was rejected.");
    }
    await response.body?.cancel();
  }
}
