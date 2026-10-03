import { createHash } from "node:crypto";
import { jcsCanonicalize, type JcsValue } from "./legacy/jcs.ts";

// Kept free of auth/db imports: applied migration 036 depends on these bytes.
export function canonical(value: unknown): string { return jcsCanonicalize(value as JcsValue); }
export function digest(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
