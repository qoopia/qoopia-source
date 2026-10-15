// Lists the non-literal operands of HTML-building string concatenations and templates in a
// browser script (audit 5.0.21 A3c, from the scratchpad sinks.cjs scanner). An operand counts as
// safe when it starts with a known escaping or formatting call; everything else is reported.
import fs from "node:fs";
import ts from "typescript";

const SAFE = /^(esc|initial|QI\.msg|QI\.count|QI\.code|QI\.date|QI\.relative|QI\.number|t|tr|e|text|escape|escapeHtml|escapeHtmlSafe|String\(|Number|fmtTime|JSON\.stringify)\b/;
const HTML = /<[a-z/!]|="|='/i;

export function htmlSinkOperands(file: string): string[] {
  const src = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const out = new Set<string>();
  const literal = (n: ts.Node): n is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
    ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
  const flat = (n: ts.Node, acc: ts.Node[]): ts.Node[] => {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) { flat(n.left, acc); flat(n.right, acc); }
    else if (ts.isParenthesizedExpression(n)) flat(n.expression, acc);
    else acc.push(n);
    return acc;
  };
  const report = (n: ts.Node) => {
    const text = n.getText(src).replace(/\s+/g, " ");
    if (!SAFE.test(text) && !ts.isNumericLiteral(n)) out.add(text.slice(0, 160));
  };
  const visit = (n: ts.Node): void => {
    const plus = (x: ts.Node) => ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken;
    if (plus(n) && !plus(n.parent)) {
      const parts = flat(n, []);
      if (parts.some((p) => literal(p) && HTML.test(p.text))) for (const p of parts) if (!literal(p)) report(p);
    }
    if (ts.isTemplateExpression(n)) {
      const strings = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join("");
      if (/<[a-z/!]/i.test(strings)) for (const s of n.templateSpans) report(s.expression);
    }
    ts.forEachChild(n, visit);
  };
  visit(src);
  return [...out].sort();
}

export const SCANNED_SCRIPTS = [
  "src/public/brand/dashboard.js",
  "src/public/brand/agent-chat.js",
  "src/public/brand/app.js",
  "src/public/brand/consent-session.js",
];
