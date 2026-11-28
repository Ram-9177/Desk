// Reads the first sheet of one uploaded .xlsx for the canteen menu upload (canteen.js), in a worker thread that canteen.js starts with a
// small memory limit and a timeout, one at a time: whatever a hostile file does, only this worker can fail, never the server.
// Nothing the file says about itself is trusted. 1) It is unpacked entry by entry from its local headers, 8 KB of input at a time,
// counting the bytes that really come out: a menu is tiny, so more than 2 MB in a part, 1 MB of shared strings or 3 MB in all stops it.
// Only the .xml / .rels parts are kept and packed again, so the reader sees only counted bytes. 2) The reader's grid is turned into
// text here and only a menu-sized result goes back: at most 501 non-blank rows, 50 used columns, 1,000 characters a cell, 500,000 in all
// (a cell is copied once per use when it is sent: 500 cells sharing one 10 MB string would otherwise be 5 GB in the server).
import { parentPort, workerData } from 'node:worker_threads';
import { Unzip, UnzipInflate, zipSync } from 'fflate';
import { readSheet } from 'read-excel-file/node';

const PART_MAX = 2 * 1024 * 1024, STRINGS_MAX = 1024 * 1024, TOTAL_MAX = 3 * 1024 * 1024;
const ROWS_MAX = 501, COLS_MAX = 50, CELL_MAX = 1000, CHARS_MAX = 500000; // header + 500 rows, as canteen.js allows
const cellText = v => v == null ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'number' ? String(+v.toPrecision(12)) : String(v).trim(); // same as canteen.js
const send = m => parentPort.postMessage(m);

function repack(buf) {
  const kept = {}; let total = 0, stop = null;
  const uz = new Unzip(); uz.register(UnzipInflate);
  uz.onfile = f => { if (stop || !/\.(xml|rels)$/i.test(f.name)) return; const parts = [], max = /sharedStrings\.xml$/i.test(f.name) ? STRINGS_MAX : PART_MAX; let n = 0;
    f.ondata = (err, d, final) => { if (stop) return; if (err) { stop = 'bad'; return; }
      n += d.length; total += d.length; if (n > max || total > TOTAL_MAX) { stop = 'big'; f.terminate(); return; }
      parts.push(d); if (final) kept[f.name] = Buffer.concat(parts); };
    f.start(); };
  try { for (let i = 0; i < buf.length && !stop; i += 8192) uz.push(buf.subarray(i, i + 8192), i + 8192 >= buf.length); } catch { stop = stop || 'bad'; }
  if (stop) return stop; if (!kept['xl/workbook.xml']) return 'bad';
  return zipSync(kept, { level: 1 });
}

const packed = repack(Buffer.from(workerData));
if (typeof packed === 'string') send({ [packed]: true });
else readSheet(Buffer.from(packed), 1).then(grid => {
  const recs = []; let chars = 0;
  for (let i = 0; i < grid.length; i++) {
    const cells = []; let used = 0;
    for (let c = 0; c < grid[i].length; c++) { const t = cellText(grid[i][c]); if (!t) continue;
      if (c >= COLS_MAX) return send({ wide: true }); if (t.length > CELL_MAX) return send({ big: true }); if ((chars += t.length) > CHARS_MAX) return send({ big: true });
      cells[c] = t; used = c + 1; }
    if (!used) continue; // blank rows don't count; row numbers stay as in the file
    if (recs.length >= ROWS_MAX) return send({ many: true });
    recs.push({ cells: Array.from({ length: used }, (_, c) => cells[c] || ''), line: i + 1 });
  }
  send({ recs });
}, () => send({ bad: true }));
