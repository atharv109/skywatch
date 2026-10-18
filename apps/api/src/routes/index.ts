import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Config } from "../config.ts";
import { defaultDeps, type AppDeps } from "../deps.ts";
import { scenarioRoutes } from "./scenario.ts";
import { mapRoutes } from "./map.ts";
import { webhookRoutes } from "./webhooks.ts";
import { toolRoutes } from "./tools.ts";
import { checkinToolRoutes, verifyRunRoutes } from "../verify/routes.ts";
import { roadRoutes } from "../roads/routes.ts";
import { meshRoutes } from "../mesh/routes.ts";
import { demoRoutes } from "./demo.ts";

/**
 * Route groups: scenario replay (Task 2), map state/stream (Task 2),
 * webhooks (Task 3 + Task 6 voice post-call), tool brief endpoints (Task 4),
 * check-in/verify tools (Task 6), roads check (Task 6), mesh (Task 8),
 * demo onboarding (Task 8g, DEMO_SIGNUP-gated).
 */
export function routes(config: Config, deps: AppDeps = defaultDeps(config)): Hono {
  const app = new Hono();
  app.route("/scenario", scenarioRoutes(config, deps));
  app.route("/map", mapRoutes(config, deps));
  app.route("/webhooks", webhookRoutes(config, deps));
  app.route("/tools", toolRoutes(config, deps));
  app.route("/tools", checkinToolRoutes(config, deps));
  app.route("/verify", verifyRunRoutes(config, deps));
  app.route("/roads", roadRoutes(config, deps));
  app.route("/mesh", meshRoutes(config, deps));
  app.route("/demo", demoRoutes(config, deps));

  /**
   * GET /b/:id — the mobile brief map-link page (demo mapLink, Task 8g): serves the
   * COPIED b.html (apps/api/public, the same file the static serve uses) with the
   * brief id INJECTED as window.SKYWATCH_BRIEF_ID before </head> (the page prefers
   * it; ?id= / the path remain fallbacks). The id is sanitized: only a Mongo-ish
   * hex id 8..32 chars — anything else is a 404, never a script-injection surface.
   * Byte-cached per read; no-store (the injection is per-request).
   */
  app.get("/b/:id", (c) => {
    const id = c.req.param("id");
    if (!/^[a-f0-9]{8,32}$/.test(id)) return c.json({ error: "no such brief" }, 404);
    let html: string;
    try {
      // import.meta.url-relative: resolves to apps/api/public/b.html on dev AND on
      // Render (tsx keeps real module paths; cwd-independent).
      html = readFileSync(fileURLToPath(new URL("../../public/b.html", import.meta.url)), "utf8");
    } catch {
      return c.json({ error: "brief page not built (copy-web missing)" }, 404);
    }
    const marker = "</head>";
    const injected = html.includes(marker)
      ? html.replace(marker, `<script>window.SKYWATCH_BRIEF_ID=${JSON.stringify(id)}</script>${marker} `)
      : `<script>window.SKYWATCH_BRIEF_ID=${JSON.stringify(id)}</script>${html}`;
    return c.body(injected, 200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  });

  return app;
}