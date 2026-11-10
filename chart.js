// Tiny chart → PNG renderer for report emails (Outlook runs no scripts and shows no SVG). No dependencies: pixels + zlib.
// Charts carry no text; the email puts the legend and labels beside the picture.
import zlib from 'node:zlib';

const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
function canvas(w, h) {
  const px = Buffer.alloc(w * h * 3, 255);
  const set = (x, y, [r, g, b]) => { x = Math.round(x); y = Math.round(y); if (x < 0 || y < 0 || x >= w || y >= h) return; const i = (y * w + x) * 3; px[i] = r; px[i + 1] = g; px[i + 2] = b; };
  const rect = (x, y, rw, rh, c) => { for (let j = Math.max(0, Math.floor(y)); j < Math.min(h, y + rh); j++) for (let i = Math.max(0, Math.floor(x)); i < Math.min(w, x + rw); i++) set(i, j, c); };
  const dot = (x, y, r, c) => { for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (i * i + j * j <= r * r) set(x + i, y + j, c); };
  const line = (x0, y0, x1, y1, c, t = 2) => { const n = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0))); for (let k = 0; k <= n; k++) dot(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n, t, c); };
  return { w, h, px, rect, dot, line };
}
function png({ w, h, px }) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; px.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
// spec: { type: 'bar' | 'line', labels: [...], max, colors?: [per-bar colour], series: [{ color: '#rrggbb', values: [number|null] }] }
export function chartPng(spec, w = 560, h = 220) {
  const c = canvas(w, h), pad = { l: 12, r: 12, t: 12, b: 12 }, iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const n = Math.max(1, spec.labels?.length || 0), series = (spec.series || []).slice(0, 8);
  const max = spec.max || Math.max(1, ...series.flatMap(s => s.values.filter(v => v != null)));
  const Y = v => pad.t + ih - (v / max) * ih, grid = hex('#eceef5');
  for (let g = 0; g <= 4; g++) c.rect(pad.l, Math.round(pad.t + ih * g / 4), iw, 1, grid);
  if (spec.type === 'bar') {
    const gw = iw / n, bw = Math.max(3, Math.floor((gw * 0.7) / Math.max(1, series.length)));
    series.forEach((s, si) => s.values.forEach((v, i) => { if (!v) return; const x = pad.l + gw * i + (gw - bw * series.length) / 2 + si * bw;
      c.rect(x, Y(v), bw - 1, pad.t + ih - Y(v), hex(spec.colors?.[i] || s.color)); }));
  } else {
    const X = i => pad.l + (n === 1 ? iw / 2 : (iw * i) / (n - 1));
    for (const s of series) { const col = hex(s.color); let prev = null;
      s.values.forEach((v, i) => { if (v == null) { prev = null; return; } if (prev) c.line(X(prev[0]), Y(prev[1]), X(i), Y(v), col, 1); c.dot(X(i), Y(v), 3, col); prev = [i, v]; }); }
  }
  return png(c);
}
