/**
 * Build-time copy: apps/web/* -> apps/api/public/ so the deployed API can serve
 * the demo web app same-origin (Render runs `npm run build --workspaces`, whose
 * @skywatch/api build step calls this; see apps/api/src/server.ts).
 *
 * Runs with cwd = apps/api (npm workspace scripts), so ../web resolves to apps/web.
 * Excludes the dev-only harness proxy (server.mjs) and README cruft — those are
 * local-development helpers, not demo assets.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dirname, "..", "..", "web");
const OUT = join(import.meta.dirname, "..", "public");
const EXCLUDE = new Set(["server.mjs", "README.md", "README-web.md"]);

if (!existsSync(WEB)) {
  console.error("copy-web: apps/web not found at", WEB, "- skipping (API-only deploy)");
  process.exit(0);
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(WEB, OUT, {
  recursive: true,
  filter: (src) => !EXCLUDE.has(src.split(/[\\/]/).pop()),
});

const files = readdirSync(OUT, { recursive: true }).length;
console.log(`copy-web: apps/web -> apps/api/public (${files} entries)`);