// Photos are kept in formats every browser and email app can show. The app shrinks photos to JPEG on the phone before
// upload; what the phone's browser can't open (HEIC from iPhones and many Android cameras, in Chrome) arrives as it is
// and is turned into JPEG here.
import decodeHeic from 'heic-decode';
import jpeg from 'jpeg-js';

// Types browsers and email apps show as pictures. Other pictures (TIFF, BMP, AVIF) are kept as files to download.
export const SHOWN = { jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
export const MIME = { ...SHOWN, heic: 'image/heic', avif: 'image/avif', bmp: 'image/bmp', tiff: 'image/tiff', pdf: 'application/pdf' };

// What a file really is, from its first bytes (a file's name and the browser's type can't be trusted)
export function kindOf(b) {
  if (!b || b.length < 12) return null;
  const s = (i, n) => b.toString('latin1', i, i + n);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (s(0, 8) === '\x89PNG\r\n\x1a\n') return 'png';
  if (s(0, 4) === 'GIF8') return 'gif';
  if (s(0, 4) === 'RIFF' && s(8, 4) === 'WEBP') return 'webp';
  if (s(0, 5) === '%PDF-') return 'pdf';
  if (s(0, 4) === 'II*\0' || s(0, 4) === 'MM\0*') return 'tiff';
  if (s(0, 2) === 'BM' && b.readUInt32LE(2) === b.length) return 'bmp';
  if (s(4, 4) === 'ftyp') { // the HEIF family: the brands say HEVC (HEIC, from phone cameras) or AV1 (AVIF)
    const brands = s(8, Math.max(0, Math.min(b.readUInt32BE(0), 64) - 8));
    if (/avi[fs]/.test(brands)) return 'avif';
    if (/^(heic|heix|hevc|hevx|mif1|msf1)/.test(brands)) return 'heic';
  }
  return null;
}

// HEIC → JPEG, at most `max` pixels on the long side (phone photos are 3000–8000 px; 1920 shows the problem clearly)
export async function heicToJpeg(buf, max = 1920) {
  const { width, height, data } = await decodeHeic({ buffer: buf });
  const k = Math.min(1, max / Math.max(width, height)), W = Math.max(1, Math.round(width * k)), H = Math.max(1, Math.round(height * k));
  return Buffer.from(jpeg.encode({ data: k < 1 ? shrink(data, width, height, W, H) : data, width: W, height: H }, 85).data);
}

// Smaller RGBA picture: each new pixel is the average of the pixels it covers
function shrink(src, w, h, W, H) {
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const y0 = Math.floor(y * h / H), y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / H));
    for (let x = 0; x < W; x++) {
      const x0 = Math.floor(x * w / W), x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / W));
      let r = 0, g = 0, bl = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let i = (yy * w + x0) * 4, e = (yy * w + x1) * 4; i < e; i += 4) { r += src[i]; g += src[i + 1]; bl += src[i + 2]; n++; }
      const o = (y * W + x) * 4; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = bl / n; out[o + 3] = 255;
    }
  }
  return out;
}
