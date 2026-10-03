/**
 * The one builder that turns human text into an SQLite FTS5 MATCH expression.
 * recall (every channel), session_search, entity/skill search and the dashboard
 * message search all route through it, so a hardening lands everywhere at once.
 *
 * Ported from the never-merged d5c12c2 with two corrections:
 *  - Control characters become separators. FTS5 ends a quoted string at U+0000
 *    and raises "unterminated string" (F-168).
 *  - The 2-character noise floor counts code points and exempts logographic
 *    scripts: one ideograph (猫) is a word, one Latin letter is noise (F-170).
 *
 * Metacharacters are neutralised by quoting each term, not by stripping them.
 * Terms with no character the unicode61 tokenizer indexes (`***`, `…`, emoji)
 * are dropped: quoted, they become an empty phrase that never matches and
 * zeroes any AND-joined caller.
 */
import { MAX_QUERY_CHARS } from "./recall/config.ts";

/** Would end the FTS5 string literal or open a group. */
const STRUCTURAL = /["`()[\]{}\p{Cc}]/gu;
/** Bareword operators; callers apply their own join. */
const OPERATOR = /^(AND|OR|NOT|NEAR)$/i;
const INDEXABLE = /[\p{L}\p{N}]/u;
const LOGOGRAPHIC = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** Well-formed expression that matches no row: "something was asked, none of it is searchable". */
export const FTS5_MATCH_NOTHING = '""';

/**
 * `candidates` is what the caller plausibly asked for; `terms` is the part FTS5
 * can match. Empty candidates means nothing was asked at all.
 */
export function analyzeFtsQuery(query: string | null | undefined): { candidates: string[]; terms: string[] } {
  const candidates = (query ?? "")
    .slice(0, MAX_QUERY_CHARS)
    .replace(STRUCTURAL, " ")
    .split(/\s+/)
    .filter((tok) => tok.length > 0 && !OPERATOR.test(tok))
    .map((tok) => tok.toLowerCase())
    // The noise floor is about prefix-matching short words; it does not apply to unindexable tokens.
    .filter((tok) => !INDEXABLE.test(tok) || [...tok].length >= 2 || LOGOGRAPHIC.test(tok));
  return { candidates, terms: candidates.filter((tok) => INDEXABLE.test(tok)) };
}

/** "" when no term is searchable. `prefix` appends `*` to each quoted term. */
export function buildFtsMatch(query: string | null | undefined, join: "OR" | "AND" = "OR", prefix = true): string {
  return analyzeFtsQuery(query).terms.map((t) => `"${t}"${prefix ? "*" : ""}`).join(` ${join} `);
}
