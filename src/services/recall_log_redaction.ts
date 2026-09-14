// REGEX SET MIRRORED FROM $QOOPIA_ROOT/docs/secret-safe-audit-rubric.md §5 — KEEP IN SYNC.
//
// Canonical source pattern from rubric §5 (single-line, case-insensitive):
//     (?i)(api[_-]?key|token|secret|password|bearer|cookie|authorization)[\s:=]+\S+
//
// Phase 1 item 6 (recall_log redactor) implements EXACTLY this pattern as
// one combined regex, capturing the matched keyword as group 1 so the
// replacement label can name the KIND. A loop of per-kind patterns would
// race when one keyword (e.g. `authorization`) wraps another (`bearer`)
// or when a later kind re-matches an earlier kind's `<REDACTED:...>`
// marker (the marker itself is non-whitespace). Single-pass over the
// input avoids that race entirely.
//
// When the rubric §5 source pattern changes, mirror the change here AND
// update the unit tests in tests/recall_log_redaction.test.ts.
//
// Hard rules from the parent plan (note 01KSBK5KDR6532W95YV11M4VVS, item 6):
//  - Pure function, no I/O, no globals beyond the pattern table.
//  - Idempotent: redactQuery(redactQuery(x)) === redactQuery(x).
//  - Bare ULIDs survive (they ARE the recall corpus). ULIDs adjacent to
//    a redaction marker (within REDACT_PROXIMITY chars) are stripped —
//    this catches "the apikey for 01HXYZ..." where the keyword pattern
//    consumes "apikey for" but not the ULID.
//  - No double-redaction: the single combined regex cannot re-enter its
//    own output because the `<` and `>` in the marker are not part of
//    the keyword alternation.

const KIND_ALTERNATION = "api[_-]?key|token|secret|password|bearer|cookie|authorization";

// One pass, one regex. Capture group 1 = keyword. Replacement derives the
// canonical KIND label (api_key for any of api_key / apikey / api-key).
const SECRET_REGEX = new RegExp(
  `\\b(${KIND_ALTERNATION})\\b[\\s:=]+\\S+`,
  "gi",
);

// Crockford base32 ULID (no I, L, O, U).
const ULID = /[0-9A-HJKMNP-TV-Z]{26}/g;

// "Adjacent" = within this many chars of an existing redaction marker.
const REDACT_PROXIMITY = 32;

// Matches a redaction marker emitted by this module — used to anchor the
// ULID proximity check (step 2) and to keep idempotency provable.
const REDACTION_MARKER = /<REDACTED:[a-z_]+>/;

export const REDACTION_KINDS: ReadonlyArray<string> = [
  "api_key",
  "token",
  "secret",
  "password",
  "bearer",
  "cookie",
  "authorization",
  "ulid",
];

function normalizeKind(rawKeyword: string): string {
  const lower = rawKeyword.toLowerCase();
  if (/^api[_-]?key$/.test(lower)) return "api_key";
  return lower;
}

export function redactQuery(text: string): string {
  if (!text) return text;
  // Step 1: collapse every secret-keyword match in a single pass over
  // the input. No risk of re-matching prior replacements because the
  // marker `<REDACTED:kind>` contains no alternation keyword.
  let out = text.replace(SECRET_REGEX, (_full, kw: string) => {
    return `<REDACTED:${normalizeKind(kw)}>`;
  });
  // Step 2: ULIDs that survived step 1. Strip ONLY when within
  // REDACT_PROXIMITY chars of an existing redaction marker. Bare ULIDs
  // (no nearby marker) are recall-corpus identifiers and MUST survive.
  out = out.replace(ULID, (match, offsetRaw, full) => {
    const offset = offsetRaw as number;
    const start = Math.max(0, offset - REDACT_PROXIMITY);
    const end = Math.min(
      (full as string).length,
      offset + match.length + REDACT_PROXIMITY,
    );
    const ctx = (full as string).slice(start, end);
    return REDACTION_MARKER.test(ctx) ? "<REDACTED:ulid>" : match;
  });
  return out;
}
