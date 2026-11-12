/**
 * Photo checks for website-chat uploads. The type is read from the file's first bytes, never
 * from its name or the type the browser declared: a script renamed to `.jpg` is refused.
 */

export interface SniffedImage {
  readonly mimeType: string;
  readonly extension: string;
}

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis"]);
const HEIF_GENERIC_BRANDS = new Set(["mif1", "msf1"]);

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

export function sniffImage(bytes: Uint8Array): SniffedImage | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: "image/jpeg", extension: "jpg" };
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((byte, index) => bytes[index] === byte)) {
    return { mimeType: "image/png", extension: "png" };
  }
  const head = ascii(bytes, 0, 6);
  if (head === "GIF87a" || head === "GIF89a") return { mimeType: "image/gif", extension: "gif" };
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return { mimeType: "image/webp", extension: "webp" };
  }
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (HEIF_BRANDS.has(brand)) return { mimeType: "image/heic", extension: "heic" };
    if (HEIF_GENERIC_BRANDS.has(brand)) return { mimeType: "image/heif", extension: "heif" };
  }
  return null;
}

/** A file name for storage: the visitor's name without its extension, plus the real one. */
export function photoFileName(original: string | null, image: SniffedImage): string {
  const name = (original ?? "").split(/[\\/]/).pop() ?? "";
  const base = name
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return `${base === "" ? "photo" : base}.${image.extension}`;
}

export const MEGABYTE = 1024 * 1024;
