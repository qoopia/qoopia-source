/**
 * Parse a Cookie header into a name→value map. Empty/missing → {}. A name sent
 * more than once is ambiguous (a sibling origin can toss a second qoopia_dash
 * next to the real one) and is left out, so every reader fails closed.
 */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  const seen = new Set<string>();
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!name) continue;
    if (seen.has(name)) {
      delete out[name];
      continue;
    }
    seen.add(name);
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}
