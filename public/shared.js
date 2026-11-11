// Shared by API and web: enums and the section 6 transition table.
export const ROLES = ['super_admin', 'tenant_admin', 'provider'];
export const STATUSES = ['open', 'in_progress', 'hold', 'closed', 'rejected'];
export const ACTIVE = ['open', 'in_progress']; // the target clock runs in these
export const PRIORITIES = ['low', 'medium', 'high', 'critical'];
export const CHANNELS = ['portal', 'walk_in', 'phone', 'internal'];
export const REQUESTOR_TYPES = ['student', 'faculty', 'staff', 'parent', 'visitor'];
// Tickets one email may raise per day on the public form, by who they are (a campus can change these on SLA & points).
// Photos / files one person can attach in one go (raise form, notes, status changes).
export const MAX_FILES = 4;
export const DAILY_LIMITS = { student: 5, faculty: 9, staff: 5, parent: 5, visitor: 5 };
// The two "about you" questions on the public form change with "I'm": [label, placeholder] for the ID and for the department.
export const WHO_FIELDS = {
  student: [['Student ID / roll no', 'e.g. 23BPT014'], ['Department / branch', 'e.g. Physiotherapy']],
  faculty: [['Faculty ID', 'e.g. FAC1024'], ['Department', 'e.g. Physiotherapy']],
  staff: [['Staff ID', 'e.g. STF2048'], ['Department / office', 'e.g. Accounts']],
  parent: [["Your ward's student ID", 'e.g. 23BPT014'], ["Ward's department", 'e.g. Physiotherapy']],
  visitor: [['Organisation / where you are from', 'e.g. ABC Hospital'], ['Purpose of your visit', 'e.g. Meeting the Dean']],
};
// A dropdown option named "Other" (or "Other …") lets people type their own answer, saved as "Other: what they typed".
export const otherOf = (options = []) => options.find(o => /^other\b/i.test(String(o).trim())) || null;
export const isOtherAnswer = (options, v) => { const o = otherOf(options); return !!o && typeof v === 'string' && (v === o || v.startsWith(o + ': ')); };
export const FIELD_TYPES = ['short_text', 'long_text', 'number', 'date', 'select', 'multi_select', 'phone', 'email', 'yes_no'];
// working hours (09:00–17:00 clock): critical 3h, high 5h, medium 8h (1 day), low 24h (3 days)
export const DEFAULT_HOURS = { critical: 3, high: 5, medium: 8, low: 24 };

const TABLE = {
  open: ['in_progress', 'hold', 'closed', 'rejected'],
  in_progress: ['hold', 'closed', 'rejected'],
  hold: ['in_progress', 'closed', 'rejected'],
  closed: ['open'],
  rejected: [],
};
// actor: 'staff' | 'requestor'. Requestor may only reopen a closed ticket (window checked by caller).
export function allowedTargets(from, actor = 'staff') {
  if (actor === 'requestor') return from === 'closed' ? ['open'] : [];
  return TABLE[from] || [];
}
export function assertTransition(from, to, actor = 'staff') {
  if (!allowedTargets(from, actor).includes(to)) {
    const e = new Error(`Cannot move a ${from} ticket to ${to}`);
    e.status = 409; e.code = 'BAD_TRANSITION'; e.details = { current: from };
    throw e;
  }
}
export const STATUS_WORDS = { open: 'Open — waiting to be picked up', in_progress: 'In progress — being worked on', hold: 'On hold', closed: 'Closed', rejected: 'Rejected' };
// name and one-line meaning of each status, for the provider's status dropdown
export const STATUS_INFO = { open: ['Open', 'not started yet'], in_progress: ['In progress', 'being worked on'],
  hold: ['On hold', 'waiting on something'], closed: ['Closed', 'work done'], rejected: ['Rejected', 'can’t be accepted'] };

// Service form types, picked by the admin per service. Each adds a fixed set of questions to the raise form.
export const FORM_TYPES = { general: 'General', location: 'Location', student: 'Student', both: 'Location & Student', food: 'Food (rate or report)' };
export const isFood = s => s?.form_type === 'food';

// ---------- Food & catering: rate a meal (feedback, no ticket) or report a serious problem (a ticket) ----------
export const MEALS = ['breakfast', 'lunch', 'snacks', 'dinner'];
export const MEAL_NAMES = { breakfast: 'Breakfast', lunch: 'Lunch', snacks: 'Snacks', dinner: 'Dinner' };
export const MEAL_COLORS = { breakfast: '#f29a1f', lunch: '#1e4b8f', snacks: '#e0559b', dinner: '#1a9a56' };
export const FOOD_CHIPS = ['Taste', 'Quantity', 'Cold food', 'Oily/Spicy', 'Hygiene look', 'Less variety', 'Menu not followed', 'Good food 👍'];
export const FOOD_CATEGORIES = [['insect', 'Insect or foreign object'], ['spoiled', 'Spoiled or stale food'], ['hygiene', 'Hygiene issue'],
  ['water', 'Water / utensils'], ['billing', 'Billing error'], ['staff', 'Staff behaviour'], ['other', 'Something else']];
export const foodCategory = k => FOOD_CATEGORIES.find(c => c[0] === k)?.[1] || k;
// a complaint sent as feedback instead keeps its category as a chip where one fits
export const CATEGORY_CHIPS = { insect: ['Hygiene look'], spoiled: ['Taste'], hygiene: ['Hygiene look'], water: ['Hygiene look'] };
export const MEAL_PALETTE = ['#f29a1f', '#1e4b8f', '#e0559b', '#1a9a56', '#7A5AF8', '#0E9384', '#B93815', '#475467'];
export const DEFAULT_MEAL_WINDOWS = { breakfast: ['06:30', '10:30'], lunch: ['11:30', '15:00'], snacks: ['15:30', '18:30'], dinner: ['19:00', '22:30'] };
// The meal to rate at a campus-local time 'HH:MM': the one being served, else the one that ended last (people rate after eating),
// else (early morning, before any meal ends) breakfast.
export function mealAt(windows = DEFAULT_MEAL_WINDOWS, hhmm = '12:00') { // windows: { key: [from, to] } for the campus's meals, in serving order
  const w = Object.entries(windows).map(([m, x]) => [m, ...x]);
  const on = w.find(([, a, b]) => hhmm >= a && hhmm < b); if (on) return on[0];
  const ended = w.filter(([, , b]) => b <= hhmm).sort((x, y) => (x[2] < y[2] ? 1 : -1))[0];
  return ended ? ended[0] : w[0]?.[0] || 'breakfast';
}
export const DEFAULT_LISTS = { block: [], floor: ['Ground floor', '1st floor', '2nd floor', '3rd floor', '4th floor'], branch: [] };
const pick = (key, label, list, placeholder) => list.length
  ? { key, label, type: 'select', options: list, required: true, builtin: true }
  : { key, label, type: 'short_text', required: true, placeholder, builtin: true };
export const isGeneral = s => !['location', 'student', 'both'].includes(s?.form_type);
export const hasLocation = s => ['location', 'both'].includes(s?.form_type);
export const hasStudent = s => ['student', 'both'].includes(s?.form_type);
// The built-in questions for a service's form type (location set and/or student set).
export function builtinFields(schema = {}) {
  const l = { ...DEFAULT_LISTS, ...(schema.lists || {}) }, out = [];
  if (hasStudent(schema)) out.push({ key: 'stu_branch', label: 'Branch', type: 'short_text', required: true, placeholder: 'e.g. BPT', builtin: true }, { key: 'stu_id', label: 'Student ID', type: 'short_text', required: true, placeholder: 'e.g. 23BPT014', builtin: true },
    { key: 'stu_dept', label: 'Department', type: 'short_text', required: true, builtin: true });
  if (hasLocation(schema)) out.push(pick('loc_block', 'Block', l.block, 'e.g. Main block'), pick('loc_floor', 'Floor', l.floor, 'e.g. 2nd floor'),
    { key: 'loc_room', label: 'Location / room', type: 'short_text', required: true, placeholder: 'e.g. Room 214, near the lift', builtin: true });
  return out;
}
export const fieldsOf = (schema = {}) => [...builtinFields(schema), ...(schema.fields || [])];
