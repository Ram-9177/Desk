// Photos are kept in formats every browser and email app can show. The app shrinks photos to JPEG on the phone before
// upload; what the phone's browser can't open (HEIC from iPhones and many Android cameras, in Chrome) arrives as it is
// and is turned into JPEG here.
import decodeHeic from 'heic-decode';
import jpeg from 'jpeg-js';
import zlib from 'node:zlib';

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

// Documents a notice may carry: PDF, Word, Excel. Decided by what is inside the file, never by its name.
export const DOC_MIME = { pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword', xls: 'application/vnd.ms-excel' };
export const EXT = { jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp', heic: 'heic', avif: 'avif', bmp: 'bmp', tiff: 'tiff', pdf: 'pdf', docx: 'docx', xlsx: 'xlsx', doc: 'doc', xls: 'xls' };

// The files inside a zip, read from its directory at the end of the file. null when this is not a zip we can read.
function zipEntries(b) {
  let e = -1; for (let i = b.length - 22, min = Math.max(0, b.length - 65557); i >= min; i--) if (b.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) return null;
  const count = b.readUInt16LE(e + 10), size = b.readUInt32LE(e + 12), start = b.readUInt32LE(e + 16);
  if (!count || count > 5000 || start + size > b.length) return null; // empty, huge, or zip64: not what Word and Excel save
  const out = []; let p = start;
  for (let i = 0; i < count; i++) {
    if (p + 46 > b.length || b.readUInt32LE(p) !== 0x02014b50) return null;
    const nlen = b.readUInt16LE(p + 28);
    out.push({ name: b.toString('utf8', p + 46, p + 46 + nlen), method: b.readUInt16LE(p + 10), csize: b.readUInt32LE(p + 20), usize: b.readUInt32LE(p + 24), offset: b.readUInt32LE(p + 42) });
    p += 46 + nlen + b.readUInt16LE(p + 30) + b.readUInt16LE(p + 32);
  }
  return out;
}
// One small text file from the zip
function zipText(b, e, max = 2e6) {
  if (!e || e.usize > max || e.offset + 30 > b.length || b.readUInt32LE(e.offset) !== 0x04034b50) return null;
  const at = e.offset + 30 + b.readUInt16LE(e.offset + 26) + b.readUInt16LE(e.offset + 28), raw = b.subarray(at, at + e.csize);
  try { return e.method === 0 ? raw.toString('utf8') : e.method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: max }).toString('utf8') : null; } catch { return null; }
}
// A plain Word (.docx) or Excel (.xlsx) file. Refused: macro-enabled files and templates (whatever they are named),
// macro sheets, ActiveX parts, and any zip that merely carries a Word-looking name inside (a .jar, a zip with a program).
const OFFICE_MAIN = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml' };
function officeKind(b) {
  const es = zipEntries(b); if (!es) return null;
  const types = zipText(b, es.find(e => e.name === '[Content_Types].xml')); if (!types) return null;
  const kind = Object.keys(OFFICE_MAIN).find(k => types.includes(OFFICE_MAIN[k])); if (!kind) return null; // .docm, .xlsm, templates and everything else stop here
  if (/macroenabled|vbaproject|macrosheet|activex/i.test(types)) return null;
  const home = kind === 'docx' ? 'word/' : 'xl/';
  const fine = n => n === '[Content_Types].xml' || /^(_rels|docProps|customXml|_xmlsignatures)\//.test(n) || n.startsWith(home);
  if (!es.some(e => e.name.startsWith(home)) || es.some(e => !fine(e.name) || /vbaproject|vbadata|macrosheet|activex/i.test(e.name) || /\.(exe|dll|com|scr|msi|bat|cmd|ps1|vbs|js|jse|wsf|hta|jar|lnk)$/i.test(e.name))) return null;
  return kind;
}
// Old Word / Excel (.doc, .xls): which one from the streams inside; a file with a VBA project (macros) is refused
function oleKind(b) {
  const has = t => b.includes(Buffer.from(t, 'utf16le'));
  if (has('_VBA_PROJECT')) return null;
  return has('WordDocument') ? 'doc' : has('Workbook') || has('Book') ? 'xls' : null;
}
export function docKindOf(b) {
  const k = kindOf(b); if (k) return k;
  if (!b || b.length < 8) return null;
  if (b.readUInt32BE(0) === 0x504b0304) return officeKind(b);
  if (b.readUInt32BE(0) === 0xd0cf11e0 && b.readUInt32BE(4) === 0xa1b11ae1) return oleKind(b);
  return null;
}
// The name a stored file is given back with: its own name, ending in the type it really is (so "tools.zip" can't be a
// name for a Word file, and a long name keeps its ending)
export function safeName(name, kind, max = 120) {
  const ext = EXT[kind] || 'bin', base = String(name || '').replace(/[\u0000-\u001f\\/]+/g, ' ').trim().replace(/\.[A-Za-z0-9]{1,5}$/, '').trim() || 'file';
  return `${base.slice(0, max - ext.length - 1)}.${ext}`;
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
