// RFC 8785 (JCS) canonicalization — subset sufficient for registry payloads.
// Numbers: only safe integers are accepted (all chain fields are epoch-ms / seq
// integers); anything else would need full ES-number serialization and is a bug.
//
// THE WELL-FORMEDNESS RULE IS NOT STATED HERE. It used to be — twice, as
// `!value.isWellFormed()` and `!k.isWellFormed()`, each throwing a BARE `Error`.
// Two consequences, and the second is the one that reached a client. First, a
// second spelling of a rule that lives in `src/outcome.ts` is how two spellings
// of one rule come apart (round 5, round 9b, D-12). Second, `handleRest` and the
// MCP adapter map an `ApiError` and re-raise everything else, so a revocation
// `reason` holding an unpaired surrogate — a request the declared schema accepts
// — was answered `500 INTERNAL`. `assertWellFormedText` throws a `RefusedText`,
// which `src/errors.ts` maps for every surface at once.
import { assertWellFormedText } from "./outcome.ts";

export type JcsValue =
  | string
  | number
  | boolean
  | null
  | JcsValue[]
  | { [k: string]: JcsValue };

export function jcsCanonicalize(value: JcsValue): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      // RFC 8785 section 3.2.2.3: ES6 Number::toString. JSON.stringify emits exactly
      // that for every finite double (integer or fractional); non-finite
      // numbers have no JSON representation at all.
      if (!Number.isFinite(value)) throw new Error("JCS: non-finite number");
      return JSON.stringify(value);
    case "string":
      // RFC 8785 input must be well-formed Unicode: reject lone surrogates
      return JSON.stringify(assertWellFormedText(value, "a string in a canonicalized payload"));
    case "object": {
      if (Array.isArray(value)) {
        return "[" + value.map(jcsCanonicalize).join(",") + "]";
      }
      // RFC 8785 section 3.2.3: sort property names by UTF-16 code units.
      // Member NAMES are subject to the same well-formed-Unicode rule as values.
      const keys = Object.keys(value).sort();
      for (const k of keys) assertWellFormedText(k, "a member name in a canonicalized payload");
      const parts = keys.map((k) => JSON.stringify(k) + ":" + jcsCanonicalize(value[k]));
      return "{" + parts.join(",") + "}";
    }
    default:
      throw new Error(`JCS: unsupported type ${typeof value}`);
  }
}

export function jcsBytes(value: JcsValue): Buffer {
  return Buffer.from(jcsCanonicalize(value), "utf8");
}

/**
 * Decode UTF-8 bytes strictly (no U+FFFD replacement) — canonicalization input
 * must be well-formed UTF-8, otherwise distinct byte strings would collapse to
 * the same manifest and share a hash.
 */
export function utf8Decode(bytes: Buffer): string {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return text;
}

/**
 * Strict JSON parse for canonicalization inputs: rejects duplicate object keys
 * (RFC 8785 section 3.1 input requirement — JSON.parse silently keeps the last
 * one).
 */
export function parseJsonStrict(text: string): JcsValue {
  const value = JSON.parse(text) as JcsValue; // syntax errors surface here first
  let i = 0;
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i])) i++;
  };
  const scanString = (): string => {
    // assumes text[i] === '"'
    let out = "";
    i++;
    while (i < text.length) {
      const c = text[i];
      if (c === '"') {
        i++;
        return out;
      }
      if (c === "\\") {
        out += text[i + 1] === "u" ? JSON.parse(`"${text.slice(i, i + 6)}"`) : JSON.parse(`"${text.slice(i, i + 2)}"`);
        i += text[i + 1] === "u" ? 6 : 2;
      } else {
        out += c;
        i++;
      }
    }
    throw new Error("JCS: unterminated string");
  };
  const scanValue = (): void => {
    ws();
    const c = text[i];
    if (c === "{") {
      i++;
      const seen = new Set<string>();
      ws();
      if (text[i] === "}") {
        i++;
        return;
      }
      for (;;) {
        ws();
        const key = scanString();
        if (seen.has(key)) throw new Error(`JCS: duplicate object key "${key}"`);
        seen.add(key);
        ws();
        i++; // ':'
        scanValue();
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        i++; // '}'
        return;
      }
    } else if (c === "[") {
      i++;
      ws();
      if (text[i] === "]") {
        i++;
        return;
      }
      for (;;) {
        scanValue();
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        i++; // ']'
        return;
      }
    } else if (c === '"') {
      scanString();
    } else {
      while (i < text.length && !",]}".includes(text[i]) && !" \t\n\r".includes(text[i])) i++;
    }
  };
  scanValue();
  return value;
}
