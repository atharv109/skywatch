/**
 * Skywatch on-device vision worker (module worker, spawned lazily by vision.js).
 * Runs the MobileCLIP-S1 VISION tower only (label text embeddings are precomputed in
 * vision-labels.json), via transformers.js -> onnxruntime-web: WebGPU when available,
 * wasm otherwise. The library is pinned and comes from jsdelivr; sw.js runtime-caches it,
 * and transformers.js keeps the ~86 MB weights in the Cache API ("transformers-cache"),
 * so after one download the whole pipeline runs with no network.
 *
 * Protocol (main -> worker):  {t:"load"} | {t:"classify", id, blob}
 *          (worker -> main):  {t:"progress", file, loaded, total} | {t:"ready", device} |
 *                             {t:"embedding", id, data:number[]} | {t:"error", id?, message}
 */
import { env, AutoProcessor, CLIPVisionModelWithProjection, RawImage } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0/dist/transformers.min.js";

const MODEL = "Xenova/mobileclip_s1";
env.allowLocalModels = false;
env.useBrowserCache = true;

let proc = null;
let model = null;
let device = "wasm";

const progress_callback = (p) => {
  if (p && p.status === "progress") self.postMessage({ t: "progress", file: p.file, loaded: p.loaded, total: p.total });
};

async function loadModel(dev) {
  return CLIPVisionModelWithProjection.from_pretrained(MODEL, { dtype: "fp32", device: dev, progress_callback });
}

async function load() {
  if (model) return;
  proc = await AutoProcessor.from_pretrained(MODEL);
  const wantGpu = typeof self.navigator !== "undefined" && !!self.navigator.gpu;
  try {
    device = wantGpu ? "webgpu" : "wasm";
    model = await loadModel(device);
  } catch (e) {
    if (!wantGpu) throw e;
    device = "wasm"; // WebGPU init failed -> wasm fallback
    model = await loadModel(device);
  }
}

async function embed(blob) {
  const img = await RawImage.fromBlob(blob);
  const { image_embeds } = await model(await proc(img));
  return Array.from(image_embeds.data);
}

self.onmessage = async (e) => {
  const m = e.data || {};
  try {
    if (m.t === "load") {
      await load();
      self.postMessage({ t: "ready", device });
    } else if (m.t === "classify") {
      await load();
      let data;
      try {
        data = await embed(m.blob);
      } catch (err) {
        if (device !== "webgpu") throw err;
        device = "wasm"; // a WebGPU run can fail at first inference on some phones -> retry on wasm once
        model = await loadModel("wasm");
        data = await embed(m.blob);
      }
      self.postMessage({ t: "embedding", id: m.id, data });
    }
  } catch (err) {
    self.postMessage({ t: "error", id: m.id, message: String((err && err.message) || err) });
  }
};
