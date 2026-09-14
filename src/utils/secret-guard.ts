/**
 * Reject text that appears to contain secrets before persisting it into
 * notes, session messages, summaries, or activity logs.
 */
import { QoopiaError } from "./errors.ts";

interface SecretDetector {
  label: string;
  re: RegExp;
}

/**
 * §truncation — deliberate detection floors.
 *
 * A leaked token is often stored partially cut: log elision, a copy/paste that
 * clipped, or an author writing down "the shape" of a key. Each detector below
 * therefore accepts the shortest payload that is still a plausible credential
 * fragment, not just the full-length key. Below that floor we stop matching on
 * purpose — short fragments are unusable as credentials, and matching them
 * would start refusing placeholders and ordinary prose, which is worse than
 * useless because a guard that fires on normal notes gets routed around.
 *
 * Floors that are known and accepted, not oversights:
 *   - `sk-or-v1-` with fewer than 8 payload chars. The corpus already contains
 *     the literal placeholder `sk-or-v1..`, which must stay writable.
 *   - `Bearer ` with fewer than 20 payload chars — below that the payload is
 *     not distinguishable from an ordinary word.
 *   - `AKIA` without its full 16-char body: AWS key IDs are fixed length, so a
 *     shorter match would fire on any mention of the prefix.
 *   - `q_`/`qa_`/`qr_`/`qc_`/`qcs_` with fewer than 16 payload chars.
 *   - `sk-` (OpenAI) with fewer than 20 payload chars — the prefix is only
 *     three characters, so a lower floor collides with hyphenated text.
 *   - A JWT missing its signature segment (`header.payload` only).
 *   - `sk-ant-` followed by a pure lowercase kebab-case word run with no
 *     `api<dd>` version marker. Real Anthropic keys always carry that marker,
 *     so this costs no detection (measured, see the detector) and it is what
 *     keeps ordinary identifiers like `sk-ant-documentation` writable.
 *
 * Every floor above is pinned by a test asserting the NON-hit, so a later
 * broadening of a pattern cannot silently erase one of these decisions.
 *
 * Accepted over-trigger: an all-caps/base32-shaped identifier placed directly
 * after the literal word `Bearer ` (e.g. `Bearer 01KYRGKFRC16J7F9MERA0R603A`)
 * is refused. In that position a ULID and an opaque access token are not
 * distinguishable, and refusing is the safe direction.
 */
const BASE_SECRET_DETECTORS: SecretDetector[] = [
  {
    label: "qoopia-token",
    re: /(?:q_|qa_|qr_|qc_|qcs_)[A-Za-z0-9_\-]{16,}/,
  },
  {
    // Floor lowered from 36 to 20 so a clipped PAT is still caught; `ghp_`
    // and its siblings are specific enough that 20 payload chars carry no
    // realistic false-positive risk.
    label: "github-pat",
    re: /gh[pousr]_[A-Za-z0-9]{20,}/,
  },
  {
    // Fine-grained PATs use a different prefix and an underscore inside the
    // payload, so `gh[pousr]_` never matched them at all.
    label: "github-fine-grained-pat",
    re: /github_pat_[A-Za-z0-9_]{20,}/,
  },
  {
    label: "openai-key",
    re: /sk-[A-Za-z0-9]{20,}/,
  },
  {
    label: "openai-project-key",
    re: /sk-proj-[A-Za-z0-9]{40,}/,
  },
  {
    label: "aws-access-key-id",
    re: /AKIA[0-9A-Z]{16}/,
  },
  {
    label: "aws-secret-access-key",
    re: /aws_secret_access_key[^A-Za-z0-9]{0,20}[A-Za-z0-9/+=]{40}/i,
  },
  {
    label: "jwt",
    re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  },
  {
    // Floor lowered from 40 to 12: the corpus sweep found a ~22-char
    // `sk-ant-api…` fragment that the 40-char floor let through.
    //
    // A flat 12-char floor over-triggered on ordinary lowercase identifiers
    // (`sk-ant-documentation`, `sk-ant-api-reference`), so the payload is
    // gated on shape as well as length, the same way `bearer-token` is:
    //   - first alternative: the real Anthropic version marker `api<dd>-`,
    //     which catches a genuine key from just four payload chars past it;
    //   - second alternative: any 12+ payload that is NOT a plain lowercase
    //     kebab-case word run.
    // Measured against the real truncated fragment in note
    // 01KNYZGDDK0Q6097MHBTFXYT7T (predicate-only probe, value never read into
    // an agent context): floor-40 missed it, floor-12 matched 22 chars, and
    // this refined form still matches the same 22 chars. The fragment carries
    // the `api<dd>` marker, so it is caught by the first alternative outright.
    label: "anthropic-key",
    re: /sk-ant-(?:api[0-9]{2}[-_][A-Za-z0-9_-]{4,}|(?![a-z]+(?:-[a-z]+)*\b)[A-Za-z0-9_-]{12,})/,
  },
  {
    // V-N1: OpenRouter keys are `sk-or-v1-` + 64 hex. `openai-key`
    // (`sk-[A-Za-z0-9]{20,}`) never matched them because the `or` segment is
    // terminated by a hyphen after two characters.
    label: "openrouter-key",
    re: /sk-or-v1-[A-Za-z0-9]{8,}/,
  },
  {
    // V-N1: the form that actually reached the corpus (2GIS access token,
    // `Bearer ` + 40 chars) and had no detector at all.
    //
    // Precision comes from the shape of the payload rather than its length
    // alone: the negative lookahead drops payloads that are just lowercase
    // words, optionally snake_cased or kebab-cased ("Bearer
    // authentication_required", "Bearer token-based-authentication-scheme"),
    // which is what the word "bearer" is followed by in prose. Anything else
    // of 20+ token characters is treated as a credential.
    label: "bearer-token",
    re:
      /\bBearer[ \t]+(?![A-Za-z]+(?:[_-][A-Za-z]+)*\b)[A-Za-z0-9._~+/=-]{20,}/i,
  },
  {
    label: "slack-token",
    re: /xox[baprs]-[0-9A-Za-z-]{20,}/,
  },
  {
    label: "stripe-secret-key",
    re: /sk_live_[A-Za-z0-9]{24,}/,
  },
  {
    label: "stripe-public-key",
    re: /pk_live_[A-Za-z0-9]{24,}/,
  },
  {
    label: "ssh-private-key",
    re: /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
  },
];

function warnSecretPattern(message: string): void {
  console.warn(`[secret-guard] ${message}`);
}

function compileSecretDetector(
  label: string,
  pattern: string,
): SecretDetector | null {
  try {
    return {
      label,
      re: new RegExp(pattern),
    };
  } catch (err) {
    warnSecretPattern(
      `Skipping invalid QOOPIA_SECRET_PATTERNS_EXTRA detector '${label}': ${err}`,
    );
    return null;
  }
}

/**
 * Custom secret detectors from env.
 *
 * Preferred format:
 * `QOOPIA_SECRET_PATTERNS_EXTRA='[{"label":"foo","pattern":"foo[a,b]bar"}]'`
 *
 * Migration path:
 * - if the value starts with `[` -> parse JSON array of `{label, pattern}`
 * - otherwise -> treat as legacy comma-separated pattern list, emit a
 *   deprecation warning, and auto-label entries as `custom-secret-N`
 */
function extraSecretDetectors(): SecretDetector[] {
  const raw = process.env.QOOPIA_SECRET_PATTERNS_EXTRA || "";
  if (!raw.trim()) return [];

  if (raw.trimStart().startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as Array<{ label?: unknown; pattern?: unknown }>;
      if (!Array.isArray(parsed)) {
        warnSecretPattern(
          "QOOPIA_SECRET_PATTERNS_EXTRA JSON payload is not an array; skipping custom detectors",
        );
        return [];
      }
      return parsed
        .map((entry, idx) => {
          const label = String(entry?.label || `custom-secret-${idx + 1}`);
          const pattern = typeof entry?.pattern === "string" ? entry.pattern : "";
          if (!pattern) {
            warnSecretPattern(
              `Skipping QOOPIA_SECRET_PATTERNS_EXTRA detector '${label}': missing pattern`,
            );
            return null;
          }
          return compileSecretDetector(label, pattern);
        })
        .filter((detector): detector is SecretDetector => detector !== null);
    } catch (err) {
      warnSecretPattern(
        `Invalid JSON in QOOPIA_SECRET_PATTERNS_EXTRA; skipping custom detectors: ${err}`,
      );
      return [];
    }
  }

  warnSecretPattern(
    "QOOPIA_SECRET_PATTERNS_EXTRA legacy CSV format is deprecated; switch to JSON array syntax",
  );
  return raw
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .map((pattern, idx) =>
      compileSecretDetector(`custom-secret-${idx + 1}`, pattern)
    )
    .filter((detector): detector is SecretDetector => detector !== null);
}

function allSecretDetectors(): SecretDetector[] {
  return [...BASE_SECRET_DETECTORS, ...extraSecretDetectors()];
}

export function detectSecretLabels(text: string): string[] {
  if (!text) return [];
  const labels: string[] = [];
  for (const detector of allSecretDetectors()) {
    if (detector.re.test(text)) {
      labels.push(detector.label);
    }
  }
  return labels;
}

export function assertNoSecrets(text: string, context: string): void {
  const labels = detectSecretLabels(text);
  if (labels.length > 0) {
    throw new QoopiaError(
      "INVALID_INPUT",
      `Secret pattern (${labels[0]}) detected in ${context} — refused. Never store plaintext keys/tokens in Qoopia.`,
    );
  }
}

/** Capture-only redaction. Existing note/session writes continue to refuse secrets. */
export function redactSensitive(text: string): { text: string; categories: string[] } {
  const categories = new Set<string>();
  let clean = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, () => {
    categories.add('private-key'); return '[REDACTED:private-key]';
  });
  for (const { label, re } of allSecretDetectors()) {
    clean = clean.replace(new RegExp(re.source, re.flags.replace('g', '') + 'g'), () => {
      categories.add(label); return `[REDACTED:${label}]`;
    });
  }
  clean = clean.replace(/\b(?:password|api_key|secret|token)\s*[:=]\s*["']?[^\s"',;]{8,}/gi, () => {
    categories.add('credential-assignment'); return '[REDACTED:credential-assignment]';
  }).replace(/https?:\/\/[^\s/:]+:[^\s/@]+@[^\s]+/gi, () => {
    categories.add('credential-url'); return '[REDACTED:credential-url]';
  }).replace(/(?:\/(?:Users|home|private|tmp|var)\/[^\s"'`,;]+|[A-Za-z]:[\\/][^\s"'`,;]+)/g, (path: string, offset: number, source: string) => {
    // Serialized JSON/JSONL can end a path match with quote-escape backslashes.
    // Keep only that punctuation before a double quote, never a path segment or
    // arbitrary suffix. Internal Windows separators and their following bytes
    // remain redacted; unquoted trailing separators are removed as before.
    const escapes = source[offset + path.length] === '"' ? path.match(/\\+$/)?.[0] ?? '' : '';
    categories.add('absolute-path'); return '[LOCAL_PATH]' + escapes;
  });
  return { text: clean, categories: [...categories].sort() };
}
