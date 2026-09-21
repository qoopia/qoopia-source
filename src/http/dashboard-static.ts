import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { assetPath } from "../utils/assets.ts";
import { securityHeaders } from "./respond.ts";

// ---------- Dashboard ----------

export let dashboardHtml: string | null = null;
export let dashboardVersion = "";

export function serveDashboard(req: IncomingMessage, res: ServerResponse) {
  if (!dashboardHtml) {
    try {
      dashboardHtml = readFileSync(assetPath("src/public/dashboard.html"), "utf8");
      // Every file the page loads is part of its revision, so an open tab notices a changed script too.
      const revision = crypto.createHash("sha256").update(dashboardHtml);
      for (const name of ["app.js", "base.css", "tokens.css", "i18n.js", "dashboard.css", "dashboard.js", "agent-chat.js", "agent-chat.css", "Manrope.ttf", "graphite/qoopia-mark-ivory.svg", "graphite/qoopia-wordmark-ivory.svg"]) revision.update(readFileSync(assetPath("src/public/brand/" + name)));
      dashboardVersion = revision.digest("hex").slice(0,12);
      dashboardHtml = dashboardHtml.replaceAll("__QOOPIA_UI_REVISION__",dashboardVersion);
    } catch {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("Dashboard not found");
      return;
    }
  }
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache",
    "x-qoopia-dashboard-version": dashboardVersion,
    ...securityHeaders(req),
  });
  res.end(req.method === "HEAD" ? undefined : dashboardHtml);
}
