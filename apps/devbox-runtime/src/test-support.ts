export interface CallbackRequest {
  readonly authorization: string | undefined;
  readonly body: unknown;
}

export interface FakeCallbackServer {
  readonly fetch: typeof fetch;
  readonly requests: CallbackRequest[];
  readonly url: string;
  close(): Promise<void>;
}

export async function startFakeCallbackServer(
  responseStatus: (body: unknown) => number = () => 200,
): Promise<FakeCallbackServer> {
  const requests: CallbackRequest[] = [];
  const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    let body: unknown = null;
    try {
      body = JSON.parse(String(init?.body ?? ""));
    } catch {
      // Tests can assert the null body for malformed callback requests.
    }
    const headers = new Headers(init?.headers);
    requests.push({
      authorization: headers.get("authorization") ?? undefined,
      body,
    });
    return new Response(null, { status: responseStatus(body) });
  }) as typeof fetch;
  return {
    fetch: fakeFetch,
    requests,
    url: "http://127.0.0.1/status",
    close: async () => undefined,
  };
}
