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
// A plain Word (.docx) or Excel (.xlsx) file. 'macro' for macro-enabled files and templates (whatever they are named),
// macro sheets and ActiveX parts; null for any zip that merely carries a Word-looking name inside (a .jar, a zip with a program).
// Folders Word and Excel themselves add are fine: a Microsoft 365 sensitivity label (docMetadata/), a custom ribbon or
// toolbar (customUI/, userCustomization/), signatures (package/, _xmlsignatures/) and an editor's left-overs ([trash]/).
const OFFICE_MAIN = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml' };
function officeKind(b) {
  const es = zipEntries(b); if (!es) return null;
  const types = zipText(b, es.find(e => e.name === '[Content_Types].xml')); if (!types) return null;
  if (/macroenabled|vbaproject|macrosheet|activex/i.test(types) || es.some(e => /vbaproject|vbadata|macrosheet|activex/i.test(e.name))) return 'macro'; // .docm, .xlsm, macro templates
  const kind = Object.keys(OFFICE_MAIN).find(k => types.includes(OFFICE_MAIN[k])); if (!kind) return null; // other templates and everything else stop here
  const home = kind === 'docx' ? 'word/' : 'xl/';
  const fine = n => n === '[Content_Types].xml' || /^(_rels|docProps|customXml|_xmlsignatures|docMetadata|customUI|userCustomization|package|\[trash\])\//.test(n) || n.startsWith(home);
  if (!es.some(e => e.name.startsWith(home)) || es.some(e => !fine(e.name) || /\.(exe|dll|com|scr|msi|bat|cmd|ps1|vbs|js|jse|wsf|hta|jar|lnk)$/i.test(e.name))) return null;
  return kind;
}
// Old Word / Excel (.doc, .xls): which one from the streams inside; 'macro' for a file with a VBA project
function oleKind(b) {
  const has = t => b.includes(Buffer.from(t, 'utf16le'));
  if (has('_VBA_PROJECT')) return has('WordDocument') || has('Workbook') || has('Book') ? 'macro' : null;
  return has('WordDocument') ? 'doc' : has('Workbook') || has('Book') ? 'xls' : null;
}
// What a notice's file is: a picture kind, 'pdf', 'docx', 'xlsx', 'doc', 'xls'; 'macro' for a Word or Excel file that
// carries macros (never stored); null for anything else.
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

// A JPEG without what the camera hides in it: the place it was taken (GPS), the phone's make and model, the date, a
// small copy of the uncropped photo, editing history, and anything stuck on after the picture (the video clip of a
// "motion photo"). The picture itself is copied byte for byte: nothing is decoded or compressed again. Which way up
// the photo is shown (its orientation) and its colour profile are kept. A file this cannot read comes back unchanged.
export function jpegClean(b) {
  try {
    if (!Buffer.isBuffer(b) || b.length < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return b;
    const head = [], icc = s => s[1] === 0xE2 && s.length >= 16 && s.toString('latin1', 4, 16) === 'ICC_PROFILE\0';
    let p = 2, turn = 0, dropped = false;
    for (;;) { // the segments before the picture data
      while (p < b.length - 1 && b[p] === 0xFF && b[p + 1] === 0xFF) p++; // fill bytes
      if (p + 4 > b.length || b[p] !== 0xFF) return b;
      const m = b[p + 1]; if (m === 0xDA) break; // start of scan: the picture follows
      if (m === 0xD8 || m === 0xD9 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) return b; // not where these belong: leave the file alone
      const len = b.readUInt16BE(p + 2); if (len < 2 || p + 2 + len > b.length) return b;
      const seg = b.subarray(p, p + 2 + len); p += 2 + len;
      if (m === 0xE1 && seg.length >= 12 && seg.toString('latin1', 4, 10) === 'Exif\0\0') turn = turn || exifTurn(seg.subarray(10));
      // kept: JFIF (APP0), the colour profile (APP2 ICC), Adobe's colour marker (APP14) and everything the decoder needs.
      // Dropped: Exif and XMP (APP1), other APP segments (maker notes, multi-picture index, Photoshop/IPTC) and comments.
      if ((m >= 0xE1 && m <= 0xEF && m !== 0xEE && !icc(seg)) || m === 0xFE) dropped = true; else head.push(seg);
    }
    // the picture data, scan after scan, up to the end marker; inside it FF is always followed by 00 or a restart marker
    let q = p, end = -1;
    while (q < b.length - 1) {
      if (b[q] !== 0xFF) { q++; continue; }
      const m = b[q + 1];
      if (m === 0x00 || m === 0xFF || (m >= 0xD0 && m <= 0xD7)) { q += m === 0xFF ? 1 : 2; continue; }
      if (m === 0xD9) { end = q + 2; break; }
      if (q + 4 > b.length) break;
      const len = b.readUInt16BE(q + 2); if (len < 2 || q + 2 + len > b.length) break;
      q += 2 + len; // a table or the header of the next scan
    }
    if (end < 0) end = b.length; // no end marker found: keep everything after the header as it is
    if (!dropped && end === b.length) return b;
    const out = [b.subarray(0, 2)];
    const jfif = head.length && head[0][1] === 0xE0 ? head.shift() : null; if (jfif) out.push(jfif);
    if (turn > 1 && turn <= 8) out.push(Buffer.from([0xFF, 0xE1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4D, 0x4D, 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08,
      0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, turn, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])); // an Exif block that holds the orientation and nothing else
    return Buffer.concat([...out, ...head, b.subarray(p, end)]);
  } catch { return b; }
}
// the orientation (1 to 8) from an Exif block, 0 when it has none
function exifTurn(t) {
  if (t.length < 14) return 0;
  const le = t.toString('latin1', 0, 2) === 'II'; if (!le && t.toString('latin1', 0, 2) !== 'MM') return 0;
  const u16 = o => le ? t.readUInt16LE(o) : t.readUInt16BE(o), u32 = o => le ? t.readUInt32LE(o) : t.readUInt32BE(o);
  if (u16(2) !== 42) return 0;
  const ifd = u32(4); if (ifd + 2 > t.length) return 0;
  for (let i = 0, n = u16(ifd); i < n && ifd + 2 + (i + 1) * 12 <= t.length; i++) { const e = ifd + 2 + i * 12; if (u16(e) === 0x0112) { const v = u16(e + 8); return v >= 1 && v <= 8 ? v : 0; } }
  return 0;
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
