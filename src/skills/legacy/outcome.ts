// Exact text-validation primitives from Skillonomia outcome.ts; no outcome authority is imported.
export class RefusedText extends Error {}

export class NotWellFormedText extends RefusedText {
  constructor(what: string) {
    super(
      `${what} is not well-formed UTF-16: it holds an unpaired surrogate, which has no UTF-8 encoding of its own. ` +
        `Encoding it replaces that code unit with U+FFFD, so its digest is shared with other strings and two values ` +
        `this registry must tell apart would become one`,
    );
    this.name = "NotWellFormedText";
  }
}

export function assertWellFormedText(text: string, what: string): string {
  if (!text.isWellFormed()) throw new NotWellFormedText(what);
  return text;
}

