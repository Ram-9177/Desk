// Shared by API and web: enums and the section 6 transition table.
export const ROLES = ['super_admin', 'tenant_admin', 'provider'];
export const STATUSES = ['open', 'in_progress', 'hold', 'closed', 'rejected'];
export const ACTIVE = ['open', 'in_progress']; // the target clock runs in these
export const PRIORITIES = ['low', 'medium', 'high', 'critical'];
export const CHANNELS = ['portal', 'walk_in', 'phone', 'internal'];
export const REQUESTOR_TYPES = ['student', 'faculty', 'staff', 'parent', 'visitor'];
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
export const FORM_TYPES = { general: 'General', location: 'Location', student: 'Student', both: 'Location & Student' };
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
