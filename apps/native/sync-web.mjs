#!/usr/bin/env node
/* Copies the behavior-complete web app (apps/web) into the Capacitor webDir
 * (apps/native/www) and stamps it as the NATIVE build:
 *   1. app.html becomes www/index.html with
 *      - <script src="native-ble.js"> injected before app.js
 *      - window.SKYWATCH_NATIVE = true injected before app.js (the app.js seam
 *        switches the peer transport from the browser hotspot path to BLE on
 *        this flag alone)
 * The script is idempotent: every run rebuilds www from scratch. */
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const webDir = join(here, "..", "web");
const wwwDir = join(here, "www");

const COPY_FILES = ["app.html", "app.js", "app.css", "nav.js", "manifest.webmanifest"];
const COPY_DIRS = ["tiles", "icons", "brand"];

for (const f of COPY_FILES) statSync(join(webDir, f)); // throws if the web app moved — fail loud
rmSync(wwwDir, { recursive: true, force: true });
mkdirSync(wwwDir, { recursive: true });
for (const f of COPY_FILES) cpSync(join(webDir, f), join(wwwDir, f));
for (const d of COPY_DIRS) cpSync(join(webDir, d), join(wwwDir, d), { recursive: true });
cpSync(join(here, "native-ble.js"), join(wwwDir, "native-ble.js"));

/* index.html = the app, native-stamped */
let app = readFileSync(join(wwwDir, "app.html"), "utf8");
if (!app.includes("<script src=\"native-ble.js\"")) {
  app = app.replace("<script src=\"app.js\" defer></script>",
    "<script src=\"native-ble.js\" defer></script>\n<script>window.SKYWATCH_NATIVE = true;</script>\n<script src=\"app.js\" defer></script>");
}
if (app === readFileSync(join(wwwDir, "app.html"), "utf8")) {
  throw new Error("sync-web.mjs: injection point changed in apps/web/app.html — update the replace targets");
}
writeFileSync(join(wwwDir, "index.html"), app);

/* the service worker is a browser-cache feature; the native webview serves straight
 * from the bundle — drop it so it can never shadow a new app bundle */
rmSync(join(wwwDir, "sw.js"), { force: true });

const injected = readFileSync(join(wwwDir, "index.html"), "utf8");
console.log("[sync-web] www rebuilt — SKYWATCH_NATIVE flag injected:", injected.includes("window.SKYWATCH_NATIVE"));