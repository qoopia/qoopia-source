/** A typed `fetch` test double. Bun's `typeof fetch` also carries `fetch.preconnect`, which no
 * fake needs, so the real one is borrowed instead of casting the fake to `typeof fetch`. */
export function fakeFetch(
  impl: (input: string | URL | Request, init?: BunFetchRequestInit) => Promise<Response>,
): typeof fetch {
  return Object.assign(impl, { preconnect: fetch.preconnect });
}

/** `new Request(input, init)` for any fetch input; Bun's Request typings omit the URL overload. */
export function requestOf(input: string | URL | Request, init?: RequestInit): Request {
  return input instanceof Request ? new Request(input, init) : new Request(String(input), init);
}
