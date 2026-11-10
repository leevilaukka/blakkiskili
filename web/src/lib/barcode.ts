// Barcodes from the camera or a photo, read in the browser: the image never leaves the device,
// only the number goes to the server (GET /api/barcodes/<ean>, the same lookup as the bot's).
//
// The browser's own BarcodeDetector is used where it reads EANs (Chrome on Android, for example);
// elsewhere zxing-wasm, the decoder the bot uses for photos. Its WebAssembly file is bundled and
// served from our own origin, since the CSP allows no CDN ('wasm-unsafe-eval' lets it compile).

interface DetectedBarcode {
  rawValue: string;
}
interface NativeDetector {
  detect(source: ImageBitmapSource): Promise<DetectedBarcode[]>;
}
interface NativeDetectorClass {
  new (options: { formats: string[] }): NativeDetector;
  getSupportedFormats(): Promise<string[]>;
}

const NATIVE_FORMATS = ["ean_13", "ean_8", "upc_a"];
const ZXING_FORMATS: ("EAN-13" | "EAN-8" | "UPC-A")[] = ["EAN-13", "EAN-8", "UPC-A"];
/** Frames are scaled down to this many pixels on the long side before zxing reads them. */
const FRAME_MAX_PX = 960;

/** Digits a barcode can have: EAN-8, UPC-A (12) or EAN-13. The server checks the rest. */
export const plausibleBarcode = (s: string) => /^(\d{8}|\d{12}|\d{13})$/.test(s);
const pick = (values: string[]) => values.find(plausibleBarcode) ?? null;

let native: Promise<NativeDetector | null> | undefined;
function nativeDetector(): Promise<NativeDetector | null> {
  return (native ??= (async () => {
    const Detector = (globalThis as { BarcodeDetector?: NativeDetectorClass }).BarcodeDetector;
    if (!Detector) return null;
    try {
      const supported = await Detector.getSupportedFormats();
      if (!supported.includes("ean_13")) return null;
      return new Detector({ formats: NATIVE_FORMATS.filter((f) => supported.includes(f)) });
    } catch {
      return null;
    }
  })());
}

type ZXing = typeof import("zxing-wasm/reader");
let zxing: Promise<ZXing> | undefined;
function zxingReader(): Promise<ZXing> {
  return (zxing ??= (async () => {
    const [mod, wasm] = await Promise.all([import("zxing-wasm/reader"), import("zxing-wasm/reader/zxing_reader.wasm?url")]);
    // Instantiated here, with our own copy of the .wasm (by default zxing-wasm fetches it from a CDN).
    await mod.prepareZXingModule({
      overrides: { locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? wasm.default : prefix + path) },
      fireImmediately: true,
    });
    return mod;
  })().catch((e) => {
    zxing = undefined; // try again next time (a dropped connection, say)
    throw e;
  }));
}

/** Starts loading the decoder, so the first frame doesn't wait for it. */
export function warmUpDecoder(): void {
  void nativeDetector()
    .then((d) => (d ? null : zxingReader()))
    .catch(() => {}); // reported when a frame is read
}

let canvas: HTMLCanvasElement | undefined;
function frameData(video: HTMLVideoElement): ImageData | null {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const scale = Math.min(1, FRAME_MAX_PX / Math.max(w, h));
  const cw = Math.round(w * scale);
  const ch = Math.round(h * scale);
  canvas ??= document.createElement("canvas");
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, cw, ch);
  return ctx.getImageData(0, 0, cw, ch);
}

/** The barcode in the video's current frame, or null. */
export async function readFrame(video: HTMLVideoElement): Promise<string | null> {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
  const detector = await nativeDetector();
  if (detector) return pick((await detector.detect(video)).map((b) => b.rawValue));
  const data = frameData(video);
  if (!data) return null;
  const { readBarcodes } = await zxingReader();
  const found = await readBarcodes(data, { formats: ZXING_FORMATS, maxNumberOfSymbols: 1 });
  return pick(found.filter((b) => b.isValid).map((b) => b.text));
}

/** The barcode in a photo, or null. */
export async function readPhoto(file: Blob): Promise<string | null> {
  const detector = await nativeDetector();
  if (detector) {
    try {
      const bitmap = await createImageBitmap(file);
      try {
        const hit = pick((await detector.detect(bitmap)).map((b) => b.rawValue));
        if (hit) return hit;
      } finally {
        bitmap.close();
      }
    } catch {
      // fall through to zxing, which tries harder on a still image anyway
    }
  }
  const { readBarcodes } = await zxingReader();
  const found = await readBarcodes(file, { formats: ZXING_FORMATS, tryHarder: true, maxNumberOfSymbols: 1 });
  return pick(found.filter((b) => b.isValid).map((b) => b.text));
}
