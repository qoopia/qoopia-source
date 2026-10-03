import { jcsCanonicalize, type JcsValue } from "./legacy/jcs.ts";

// Kept free of auth/db imports: applied migration 036 depends on these bytes.
export function canonical(value: unknown): string { return jcsCanonicalize(value as JcsValue); }
export { hash as digest } from "../utils/fs.ts";
