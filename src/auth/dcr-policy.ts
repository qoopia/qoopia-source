/** Pure predicates of the dynamic-client-registration policy. No request, response or
 * database here: the HTTP layer decides what to do with the answers. */
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
