import { logger } from "./logger.ts";

const detail = (error: unknown) => error instanceof Error ? { error: error.message, stack: error.stack?.slice(0, 4000) } : { error: String(error) };

/** Bun ends the process on a rejected promise nobody handles: one forgotten .catch in a background job
 * would stop the server with a bare stack on stderr [A1-05]. A rejection is logged and the server keeps
 * serving: the request or job that lost it has already failed. An uncaught exception leaves state unknown,
 * so it is logged and the server stops through `fatal` (its normal shutdown); the supervisor restarts it. */
export function installProcessGuards(fatal: (reason: string) => void) {
  process.on("unhandledRejection", (reason) => { logger.error("Unhandled promise rejection", detail(reason)); });
  process.on("uncaughtException", (error) => { logger.error("Uncaught exception; stopping", detail(error)); fatal("uncaughtException"); });
}
