/**
 * Offline build step: embed the zero-shot label prompts ONCE (text tower, Node) and write
 * apps/web/vision-labels.json, so phones only ever download the ~12 MB vision tower.
 *
 *   npm i --prefix <scratch> @huggingface/transformers@4.2.0
 *   TRANSFORMERS=file:///<scratch>/node_modules/@huggingface/transformers/dist/transformers.node.mjs \
 *     node apps/vision/scripts/build-embeddings.mjs
 *
 * Optional: pass image paths after the script to print the on-device classifier's ranking
 * for each (same q8 vision tower the phone loads) - used for the sanity check in the report.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { LABELS, normalize, rankLabels } from "../../web/vision-core.js";

const MODEL = process.env.VMODEL || "Xenova/mobileclip_s1";
const OUT = process.env.VOUT || fileURLToPath(new URL("../../web/vision-labels.json", import.meta.url));
const tf = await import(process.env.TRANSFORMERS || "@huggingface/transformers");

const images = process.argv.slice(2);
let embs;
if (images.length && !process.env.REBUILD) {
  embs = JSON.parse(readFileSync(OUT, "utf8")).embeddings;
} else {
  const tok = await tf.AutoTokenizer.from_pretrained(MODEL);
  const text = await tf.CLIPTextModelWithProjection.from_pretrained(MODEL, { dtype: "fp32" });
  embs = {};
  for (const l of LABELS) {
    const inputs = tok(l.prompts, { padding: "max_length", truncation: true });
    const { text_embeds } = await text(inputs);
    const rows = text_embeds.tolist().map(normalize);
    const mean = rows[0].map((_, i) => rows.reduce((s, r) => s + r[i], 0) / rows.length);
    embs[l.id] = normalize(mean).map((x) => +x.toFixed(5));
  }
  writeFileSync(OUT, JSON.stringify({ model: MODEL, dim: embs[LABELS[0].id].length, embeddings: embs }));
  console.log("wrote", OUT);
}

if (images.length) {
  const proc = await tf.AutoProcessor.from_pretrained(MODEL);
  const vis = await tf.CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: process.env.VDTYPE || "fp32" });
  for (const p of images) {
    const img = await tf.RawImage.read(p);
    const { image_embeds } = await vis(await proc(img));
    const r = rankLabels(Array.from(image_embeds.data), embs);
    console.log(p, r.slice(0, 3).map((x) => `${x.id} ${(x.score * 100).toFixed(0)}%`).join(" | "));
  }
}
