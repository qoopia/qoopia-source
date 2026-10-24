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
    re: /(?:q_|qa_|qr_|qc_|qcs_)[A-Za-z0-9_-]{16,}/,
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
  // 5.0.23 (Alan's comparison): formats that reached agent transcripts with no detector.
  {
    // Google API keys are `AIza` + 35; a clipped key keeps 30.
    label: "google-api-key",
    re: /AIza[0-9A-Za-z_-]{30,}/,
  },
  {
    // `<bot id>:<35-char secret>`, as BotFather issues it.
    label: "telegram-bot-token",
    re: /\b[0-9]{8,10}:[A-Za-z0-9_-]{35}\b/,
  },
  {
    label: "gitlab-pat",
    re: /glpat-[A-Za-z0-9_-]{20,}/,
  },
  {
    label: "npm-token",
    re: /\bnpm_[A-Za-z0-9]{30,}/,
  },
  {
    // Letters only after `hf_`: a snake_case identifier (`hf_model_name`) has underscores.
    label: "huggingface-token",
    re: /\bhf_[A-Za-z]{30,}\b/,
  },
  {
    // A long hex value labelled as a key, token or secret («api_key: 9f86d0…», «secret=…»). A bare hex string
    // is a digest or a commit and stays.
    label: "hex-key",
    re: /(?:\b(?:api[_-]?key|access[_-]?key|secret|token|private[_-]?key|signing[_-]?key)|(?<!\p{L})(?:ключ|токен|секрет)(?!\p{L}))["']?\s*[:=]\s*["']?[0-9a-fA-F]{32,}\b/iu,
  },
  {
    // A service token of the form <prefix>_<30+ letters and digits> (ai-memory's aim_, and many others) — only
    // when the payload mixes upper case, lower case and digits, so snake_case identifiers stay.
    label: "prefixed-token",
    re: /\b[a-z]{2,10}_(?=[A-Za-z0-9]*[A-Z])(?=[A-Za-z0-9]*[a-z])(?=[A-Za-z0-9]*[0-9])[A-Za-z0-9]{30,}\b/,
  },
  {
    // A password written as prose, English or Russian: «DB password is "…"», «пароль: …», «пароль от
    // почты — …», «пароль такой: …». The value must look like one: quoted, or 6+ characters with a digit
    // or symbol, so «password is required» and «пароль — смотри в 1Password» stay. References such as
    // `process.env.X` or `${VAR}` are not values. Only the value is redacted (see PASSWORD_VALUE).
    label: "password",
    re: /((?:\b(?:passw(?:or)?d|passphrase|pwd)\b|(?<!\p{L})(?:пароль|пароля|паролем|код доступа)(?!\p{L}))(?:\s+(?:от|для|к|for|of|to)\s+[^\s:=]{1,40})?(?:\s*[:=]\s*|\s+(?:is|was|это|будет|такой(?:-то)?:?|[—–-])\s*))(?!process\.env|os\.environ|env\.|config\.|settings\.|getenv|\$|\{\{)(?:(["'«“])[^"'»”\n]{4,}["'»”]|(?=[^\s"'»”,;]*?[0-9!@#%^&*_+=~-])[^\s"'»”,;]{5,}[^\s"'»”,;.!?:)\]])/iu,
  },
];

/** Long random-looking strings a detector does not name (an unknown provider's key, a session secret).
 * Hex digests, UUIDs, ULIDs, paths and identifiers stay: the span must be 32+ characters mixing upper,
 * lower and 3+ digits, without a lowercase run longer than 6 (words and camelCase have them), with
 * Shannon entropy of at least 4 bits per character. Applied when memory is captured, not to explicit
 * writes: there it would refuse a whole note over, say, a document id. */
const ENTROPY_CANDIDATE = /(?<![A-Za-z0-9_+/=-])[A-Za-z0-9_+/=-]{32,256}(?![A-Za-z0-9_+/=-])/g;
export function highEntropy(token: string): boolean {
  if (/^[0-9a-f-]+$/i.test(token) || !/[A-Z]/.test(token) || !/[a-z]/.test(token) || (token.match(/[0-9]/g)?.length ?? 0) < 3) return false;
  if (/[a-z]{7,}/.test(token)) return false;
  const counts = new Map<string, number>();
  for (const ch of token) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) { const p = n / token.length; bits -= p * Math.log2(p); }
  return bits >= 4;
}

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

/**
 * Values the owner declares are not secrets, so no detector cuts or refuses them:
 * `QOOPIA_SECRET_ALLOWLIST='["sk-test-placeholder", "re:^AIzaSyFAKE"]'` — a literal, or `re:` and a pattern
 * matched against the whole span a detector found [5.0.23].
 */
function allowlist(): Array<(span: string) => boolean> {
  const raw = process.env.QOOPIA_SECRET_ALLOWLIST || "";
  if (!raw.trim()) return [];
  try {
    const entries = JSON.parse(raw) as unknown;
    if (!Array.isArray(entries)) throw new Error("not an array");
    return entries.filter((e): e is string => typeof e === "string" && e.length > 0).flatMap((entry) => {
      if (!entry.startsWith("re:")) return [(span: string) => span === entry || span.includes(entry)];
      try { const re = new RegExp(entry.slice(3)); return [(span: string) => re.test(span)]; }
      catch (err) { warnSecretPattern(`Skipping invalid QOOPIA_SECRET_ALLOWLIST pattern: ${err}`); return []; }
    });
  } catch (err) {
    warnSecretPattern(`Invalid QOOPIA_SECRET_ALLOWLIST; nothing is allowed by it: ${err}`);
    return [];
  }
}
const allowed = (span: string, list = allowlist()) => list.some((ok) => ok(span));

declare const SANITIZED: unique symbol;
/** Text that has passed the secret guard. Memory writers (notes, session messages, summaries, AgentComm,
 * agent-task transcripts) bind only this type into their statements, and only the two functions below make
 * it, so text that skipped the guard does not compile into a write [5.0.23]. */
export type Sanitized = string & { readonly [SANITIZED]: true };
/** An explicit write: a secret refuses it, as before. */
export function secretFree(text: string, context: string): Sanitized {
  assertNoSecrets(text, context);
  return text as Sanitized;
}
/** Captured memory and conversation turns: secrets are cut out and their kinds reported. */
export function sanitizedMemory(text: string): { text: Sanitized; categories: string[] } {
  const { text: clean, categories } = redactMemory(text);
  return { text: clean as Sanitized, categories };
}
/** The value a write statement binds. Takes only Sanitized, so the compiler checks each write site. */
export const stored = (text: Sanitized): string => text;

export function detectSecretLabels(text: string): string[] {
  if (!text) return [];
  const labels: string[] = [], ok = allowlist();
  for (const detector of allSecretDetectors()) {
    const re = new RegExp(detector.re.source, detector.re.flags.replace("g", "") + "g");
    if ([...text.matchAll(re)].some((m) => !allowed(m[0], ok))) labels.push(detector.label);
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

/** Replace each secret-shaped span with `[REDACTED:<label>]`; `seen` collects the labels hit. */
export function redactSecretSpans(text: string, seen?: Set<string>): string {
  let clean = text.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, () => {
    seen?.add('private-key'); return '[REDACTED:private-key]';
  });
  const ok = allowlist();
  for (const { label, re } of allSecretDetectors()) {
    clean = clean.replace(new RegExp(re.source, re.flags.replace('g', '') + 'g'), (match: string, keep?: unknown) => {
      if (allowed(match, ok)) return match;
      // The password detector keeps its own words («пароль от почты: ») and loses the value.
      seen?.add(label); return (label === 'password' && typeof keep === 'string' ? keep : '') + `[REDACTED:${label}]`;
    });
  }
  return clean;
}

/** A local path whose file is itself a credential or holds them: key material, cloud and package
 * credentials, `.env` files, keychains. Memory keeps every other path. */
const CREDENTIAL_PATH = /[\\/](?:\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|keychains?|credentials?|secrets?)(?:[\\/.]|$)|[\\/](?:\.netrc|\.pgpass|\.npmrc|\.pypirc|\.git-credentials|\.env(?:\.[\w-]+)?|id_(?:rsa|dsa|ecdsa|ed25519))$|\.(?:pem|key|p12|pfx|keystore|jks)$/i;

/** Capture-only redaction. Existing note/session writes continue to refuse secrets.
 * Operational text (logs, errors, support output, skills) also loses absolute paths; memory content
 * (`keepPaths`) keeps them, because a summary is useless without the files it is about, and only
 * paths of credential files are hidden. */
export function redactSensitive(text: string, options: { keepPaths?: boolean } = {}): { text: string; categories: string[] } {
  const categories = new Set<string>();
  const ok = allowlist();
  const clean = redactSecretSpans(text, categories).replace(ENTROPY_CANDIDATE, (token: string) => {
    if (!highEntropy(token) || allowed(token, ok)) return token;
    categories.add('high-entropy'); return '[REDACTED:high-entropy]';
  }).replace(/\b(?:password|api_key|secret|token)\s*[:=]\s*["']?[^\s"',;]{8,}/gi, () => {
    categories.add('credential-assignment'); return '[REDACTED:credential-assignment]';
  }).replace(/https?:\/\/[^\s/:]+:[^\s/@]+@[^\s]+/gi, () => {
    categories.add('credential-url'); return '[REDACTED:credential-url]';
  }).replace(/([?&][\w.-]*(?:token|secret|passw(?:or)?d|key|sig|signature|credential|auth|code)=)[^\s&#"'`]{8,}/gi, (_m: string, name: string) => {
    categories.add('credential-url'); return name + '[REDACTED:credential-url]';
  }).replace(/((?:https?|ftp):\/\/[^\s"'`,;\\]+)|\/(?:Users|home|private|tmp|var)\/[^\s"'`,;]+|[A-Za-z]:(?:\\|\/(?!\/))[^\s"'`,;]+/g, (path: string, url: string | undefined, offset: number, source: string) => {
    // Web URLs are consumed whole and kept, so their path segments are never
    // read as local paths; a backslash ends the URL so JSON escapes (\n, \t)
    // cannot hide a path. A drive letter never precedes "//" (every "://").
    if (url) return url;
    // Serialized JSON/JSONL can end a path match with quote-escape backslashes.
    // Keep only that punctuation before a double quote, never a path segment or
    // arbitrary suffix. Internal Windows separators and their following bytes
    // remain redacted; unquoted trailing separators are removed as before.
    const escapes = source[offset + path.length] === '"' ? path.match(/\\+$/)?.[0] ?? '' : '';
    if (options.keepPaths) {
      // Sentence punctuation after the path stays outside the redaction.
      const core = path.slice(0, path.length - escapes.length), trail = core.match(/[.,:;!?)\]}>]+$/)?.[0] ?? '';
      if (!CREDENTIAL_PATH.test(core.slice(0, core.length - trail.length))) return path;
      categories.add('credential-path'); return '[REDACTED:credential-path]' + trail + escapes;
    }
    categories.add('absolute-path'); return '[LOCAL_PATH]' + escapes;
  });
  return { text: clean, categories: [...categories].sort() };
}

/** Redaction for stored memory: secrets go, file paths stay (credential files excepted). */
export const redactMemory = (text: string) => redactSensitive(text, { keepPaths: true });
