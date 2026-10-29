// Business-hours SLA clock: time only counts inside the tenant's working window
// (e.g. 09:00–17:00 on working days, in the tenant's timezone).
const DAY = 864e5, MIN = 6e4;

export const DEFAULT_HOLD_REASONS = [
  { key: 'parts', label: 'Waiting for parts / material', hours: 16 },
  { key: 'requestor', label: 'Waiting for requestor', hours: 8 },
  { key: 'vendor', label: 'Third-party / vendor', hours: 24 },
  { key: 'approval', label: 'Approval pending', hours: 8 },
  { key: 'other', label: 'Other', hours: 8 },
];

// Points a provider earns when closing, by how much of the SLA window they used.
export const POINT_RULES = [
  { upTo: 0.5, points: 10, reason: 'Closed fast (under half the SLA)' },
  { upTo: 1, points: 5, reason: 'Closed within SLA' },
  { upTo: 2, points: -2, reason: 'Closed late' },
  { upTo: Infinity, points: -5, reason: 'Closed very late (over 2× SLA)' },
];
export const POINTS = { reopened: -5, holdBreach: -3 };
export const closePoints = ratio => POINT_RULES.find(r => ratio <= r.upTo);

const hm = s => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
function offsetMin(tz, d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(d).map(x => [x.type, x.value]));
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(d.getTime() / MIN) * MIN) / MIN;
}

// The local calendar day (in tz) that contains iso: its start and the next day's start, as ISO (UTC) strings.
export function localDay(tz, iso = new Date().toISOString()) {
  const d = new Date(iso), d0 = Math.floor((d.getTime() + offsetMin(tz, d) * MIN) / DAY) * DAY;
  const back = ms => new Date(ms - offsetMin(tz, new Date(ms)) * MIN).toISOString();
  return { start: back(d0), next: back(d0 + DAY) };
}
// Local midnight at the start of a 'YYYY-MM-DD' date in tz.
export const dateStart = (tz, ymd) => localDay(tz, new Date(Date.parse(ymd + 'T12:00:00Z') - offsetMin(tz, new Date(Date.parse(ymd + 'T12:00:00Z'))) * MIN).toISOString()).start;

export function calendar(tenant) {
  const days = new Set(String(tenant.work_days ?? '1,2,3,4,5,6').split(',').filter(Boolean).map(Number));
  return { tz: tenant.timezone || 'Asia/Kolkata', start: hm(tenant.work_start || '09:00'), end: hm(tenant.work_end || '17:00'), days };
}
const toLocal = (cal, iso) => { const d = new Date(iso); return d.getTime() + offsetMin(cal.tz, d) * MIN; };
const fromLocal = (cal, ms) => new Date(ms - offsetMin(cal.tz, new Date(ms)) * MIN).toISOString();
// working window [start, end) of the local day containing ms, or null on a day off
function windowOf(cal, ms) {
  const d0 = Math.floor(ms / DAY) * DAY;
  return cal.days.has(new Date(d0).getUTCDay()) ? [d0 + cal.start * MIN, d0 + cal.end * MIN] : null;
}

// The instant reached after `minutes` of working time from `iso`.
export function addWorking(cal, iso, minutes) {
  if (!cal.days.size || cal.end <= cal.start) throw new Error('No working hours configured');
  let t = toLocal(cal, iso), left = Math.max(0, minutes);
  for (let i = 0; i < 4000; i++) {
    const w = windowOf(cal, t);
    if (w && t < w[1]) {
      const from = Math.max(t, w[0]), avail = (w[1] - from) / MIN;
      if (left <= avail) return fromLocal(cal, from + left * MIN);
      left -= avail;
    }
    t = Math.floor(t / DAY) * DAY + DAY;
  }
  throw new Error('SLA window too long');
}

// Working minutes between two instants (0 if b <= a).
export function workingBetween(cal, a, b) {
  let t = toLocal(cal, a), end = toLocal(cal, b), sum = 0;
  for (let i = 0; t < end && i < 4000; i++) {
    const w = windowOf(cal, t);
    if (w) sum += Math.max(0, Math.min(end, w[1]) - Math.max(t, w[0])) / MIN;
    t = Math.floor(t / DAY) * DAY + DAY;
  }
  return Math.round(sum);
}
