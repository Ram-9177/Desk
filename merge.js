// Same-day duplicate reports. When many people report the same problem at the same place on the same day, the first report
// is the ticket and every later one joins it as another requestor, raising its priority. A report joins a ticket only when
// campus, service, place and problem match, the ticket was raised the same calendar day (campus time) and is not yet closed.
import { isOtherAnswer, fieldsOf } from './public/shared.js';

export const SIMILARITY = 0.6; // how alike two typed "Other" problems must be to count as the same (pg_trgm similarity, 0–1)
export const MERGE_MODES = ['silent', 'confirm']; // silent: join automatically · confirm: ask the person first
export const MERGEABLE = ['open', 'in_progress', 'hold']; // closed and rejected tickets never take new reports

// lower case, punctuation gone, single spaces
export const normText = s => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
// "Room no. 203", "203 room", "#203" → "203"
export const normRoom = s => normText(String(s ?? '').replace(/#/g, ' ')).replace(/\b(room|rm|no)\b/g, ' ').replace(/\s+/g, ' ').trim();

// The place: building + room for forms with a location section, the typed location for simple forms. Null: never merged.
export function locationKey(schema, fd, location) {
  if (schema?.form_type === 'location' || schema?.form_type === 'both') {
    const b = normText(fd.loc_block), r = normRoom(fd.loc_room);
    return b && r ? `${b}:${r}` : null;
  }
  const l = normRoom(location);
  return l ? `place:${l}` : null;
}
// The problem: the answer to the service's first dropdown (e.g. Fan, Light, AC). "Other: …" keeps its typed words, matched by
// similarity. A service with no dropdown has no problem picker, so its reports are never merged.
export function problemOf(schema, fd) {
  const f = fieldsOf(schema).find(x => x.type === 'select' && !/^(loc|stu)_/.test(x.key));
  const v = f && fd[f.key];
  if (!v) return null;
  if (isOtherAnswer(f.options, v)) { const typed = normText(String(v).replace(/^[^:]*:?/, '')); return typed ? { key: `other:${typed}`, label: v, fuzzy: true } : null; }
  return { key: normText(v), label: v, fuzzy: false };
}
// The calendar day in the campus time zone, 'YYYY-MM-DD'
export const dayIn = (tz, iso) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

// Priority from the number of people affected: 1–2 normal (medium), 3–9 high, 10 or more urgent (critical)
export const RANK = { low: 0, medium: 1, high: 2, critical: 3 };
export const priorityFor = n => n >= 10 ? 'critical' : n >= 3 ? 'high' : 'medium';

// Trigram similarity, the same measure as pg_trgm's similarity(), for databases without the extension
const grams = s => { const g = new Set(); for (const w of normText(s).split(' ').filter(Boolean)) { const p = `  ${w} `; for (let i = 0; i + 3 <= p.length; i++) g.add(p.slice(i, i + 3)); } return g; };
export function similarity(a, b) {
  const A = grams(a), B = grams(b); let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return A.size + B.size - n ? n / (A.size + B.size - n) : 0;
}
