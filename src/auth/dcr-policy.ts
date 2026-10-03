/** Pure predicates of the dynamic-client-registration policy. No request, response or
 * database here: the HTTP layer decides what to do with the answers. */
export const CLAUDE_AI_REDIRECT_URI = "https://claude.ai/api/mcp/auth_callback";

const CHATGPT_DCR_REDIRECT_HOSTS = new Set([
  "chat.openai.com",
  "chatgpt.com",
  "www.chatgpt.com",
]);

export function stringArrayEquals(actual: unknown, expected: string[]): boolean {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

export function stringArraySubsetOf(actual: unknown, allowed: string[]): boolean {
  return (
    actual === undefined ||
    (Array.isArray(actual) &&
      actual.length > 0 &&
      actual.every((value) => typeof value === "string" && allowed.includes(value)))
  );
}

export function isChatGptRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      CHATGPT_DCR_REDIRECT_HOSTS.has(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}

export function isChatGptRedirectArray(actual: unknown): boolean {
  return (
    Array.isArray(actual) &&
    actual.length > 0 &&
    actual.every((value) => typeof value === "string" && isChatGptRedirectUri(value))
  );
}

export function isLoopbackRedirectHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "::ffff:127.0.0.1" ||
    host === "::ffff:7f00:1"
  );
}

function isLoopbackRedirectArray(actual: unknown): boolean {
  return Array.isArray(actual) && actual.length > 0 && actual.every((value) => {
    try {
      return typeof value === "string" && isLoopbackRedirectHost(new URL(value).hostname);
    } catch {
      return false;
    }
  });
}

/** F-130: unauthenticated registration on an owner connection may name only the callback its
 * client is known to use. Surfaces without one documented callback (Claude Desktop through
 * claude.ai or the local adapter, Muse, Grok) keep the generic registerClient checks. */
export function connectionRedirectsAllowed(surface: string, redirectUris: unknown): boolean {
  switch (surface) {
    case "chatgpt_web":
    case "chatgpt_desktop":
      return isChatGptRedirectArray(redirectUris);
    case "claude_web":
      return stringArrayEquals(redirectUris, [CLAUDE_AI_REDIRECT_URI]);
    case "codex":
    case "claude_code":
      return isLoopbackRedirectArray(redirectUris);
    default:
      return true;
  }
}
