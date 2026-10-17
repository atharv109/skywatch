import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

/** apps/api/fixtures — every ingest source's REPLAY=1 fallback lives here. */
export const FIXTURES_DIR = fileURLToPath(new URL("../../fixtures/", import.meta.url));

export async function readFixture(name: string): Promise<unknown> {
  const raw = await readFile(`${FIXTURES_DIR}${name}`, "utf8");
  return JSON.parse(raw) as unknown;
}