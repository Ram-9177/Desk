// Reads the first sheet of one .xlsx for the canteen menu upload (canteen.js), in a worker thread started with a memory limit and
// a timeout: a sheet that blows up while it is read (one cell at XFD200000 makes the reader build a 200,000 x 16,384 grid) ends
// this worker, never the server. The file it gets holds only the XML parts canteen.js has already unpacked and counted.
import { parentPort, workerData } from 'node:worker_threads';
import { readSheet } from 'read-excel-file/node';

const MAX_ROWS = 2000, MAX_COLS = 1000; // far above a menu (500 x 50); only stops a huge grid being copied back
readSheet(Buffer.from(workerData), 1).then(
  rows => parentPort.postMessage(rows.length > MAX_ROWS || rows.some(r => r.length > MAX_COLS) ? { big: true } : { rows }),
  e => parentPort.postMessage({ error: String(e?.message || e) }));
