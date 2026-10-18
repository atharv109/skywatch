# apps/web

Placeholder — owned by the web teammate.

**Deploy note:** on deploy the API serves this directory — `apps/api` build copies it to `apps/api/public/` and serves it same-origin (`/`, `/app.html`, `/ops.html`, harness pages, `manifest.webmanifest`, `sw.js`, `icons/`), so the demo app installs on phones straight from the deployed Render URL (no CORS, no separate web host). Locally it is still served by `node apps/web/server.mjs` with the API proxied.