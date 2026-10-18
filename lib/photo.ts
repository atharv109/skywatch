const MAX_EDGE = 1024;
const MAX_BYTES = 100 * 1024;

function blobOf(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

export async function downscalePhoto(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  let width = bitmap.width;
  let height = bitmap.height;
  const edge = Math.max(width, height);
  if (edge > MAX_EDGE) {
    const scale = MAX_EDGE / edge;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas");
  let quality = 0.72;
  let dataUrl = "";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    canvas.width = width;
    canvas.height = height;
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await blobOf(canvas, quality);
    if (!blob) throw new Error("encode");
    dataUrl = await blobToDataUrl(blob);
    if (blob.size <= MAX_BYTES) break;
    if (quality > 0.45) quality -= 0.1;
    else {
      width = Math.round(width * 0.8);
      height = Math.round(height * 0.8);
    }
  }
  bitmap.close();
  return dataUrl;
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("read"));
    reader.readAsDataURL(blob);
  });
}
