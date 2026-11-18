// Tidy a provider's note before the requester sees it: spelling, common short-forms and sentence form.
// Runs entirely on this server (British English dictionary + lists below). No API, nothing leaves the machine.
// It never changes the meaning: words it does not know and cannot confidently correct are left as they are.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import nspell from 'nspell';

const require = createRequire(import.meta.url), dictDir = require.resolve('dictionary-en-gb').replace(/index\.js$/, '');
const spell = nspell(fs.readFileSync(dictDir + 'index.aff'), fs.readFileSync(dictDir + 'index.dic'));

// Short-forms and the usual typos, mapped to the proper word(s)
export const SHORT = {
  u: 'you', ur: 'your', r: 'are', y: 'why', n: 'and', nd: 'and', pls: 'please', plz: 'please', plss: 'please', pl: 'please', thx: 'thanks', tnx: 'thanks', thnx: 'thanks', ty: 'thank you',
  msg: 'message', coz: 'because', cos: 'because', bcoz: 'because', bcz: 'because', bcos: 'because', becoz: 'because', asap: 'as soon as possible', abt: 'about', wat: 'what', wht: 'what',
  hv: 'have', hav: 'have', ppl: 'people', b4: 'before', '2day': 'today', tdy: 'today', tmrw: 'tomorrow', tmr: 'tomorrow', tmrrw: 'tomorrow', '2mrw': 'tomorrow', '2moro': 'tomorrow',
  im: "I'm", ive: "I've", ill: "I'll", dont: "don't", cant: "can't", wont: "won't", didnt: "didn't", doesnt: "doesn't", isnt: "isn't", wasnt: "wasn't", havent: "haven't", hasnt: "hasn't", couldnt: "couldn't", shouldnt: "shouldn't", wouldnt: "wouldn't", thats: "that's", whats: "what's", theres: "there's", lets: "let's",
  wil: 'will', wll: 'will', tommorow: 'tomorrow', tomorow: 'tomorrow', tommorrow: 'tomorrow', recieved: 'received', recieve: 'receive', definately: 'definitely', seperate: 'separate', untill: 'until', occured: 'occurred',
  alot: 'a lot', infact: 'in fact', ofcourse: 'of course', atleast: 'at least', incase: 'in case', aswell: 'as well', kindly: 'kindly', sry: 'sorry', srry: 'sorry', rply: 'reply', reg: 'regarding', regd: 'regarding', wrt: 'regarding',
  bcse: 'because', becuase: 'because', becasue: 'because', teh: 'the', adn: 'and', taht: 'that', wiht: 'with', woking: 'working', wroking: 'working', compleated: 'completed', complted: 'completed', complete: 'complete',
  replaced: 'replaced', repaired: 'repaired', repaird: 'repaired', fixd: 'fixed', chked: 'checked', chkd: 'checked', chk: 'check', bulb: 'bulb', tubelight: 'tube light', tubelite: 'tube light',
};
// Words that are right as they are on a campus (not in the dictionary, never "corrected")
export const CAMPUS_WORDS = ['wifi', 'wi-fi', 'erp', 'lms', 'mcb', 'rccb', 'elcb', 'ups', 'ac', 'acs', 'dg', 'ro', 'cctv', 'ip', 'lan', 'hod', 'hods', 'id', 'ids', 'otp', 'pdf', 'upi', 'neft',
  'choke', 'ballast', 'geyser', 'geysers', 'inverter', 'invertor', 'sump', 'overhead', 'mess', 'canteen', 'hostel', 'hostels', 'warden', 'wardens', 'block', 'lab', 'labs', 'okay', 'ok', 'bpt', 'bot', 'mpt', 'b.sc', 'm.sc',
  'pg', 'ug', 'smru', 'roll', 'dal', 'sambar', 'chapati', 'chapatis', 'roti', 'idli', 'dosa', 'upma', 'poha', 'biryani', 'curd', 'rasam', 'paneer', 'veg', 'nonveg', 'whatsapp', 'gmail', 'outlook', 'teams', 'zoom'];
const VOWELLESS = /^[^aeiouy]+$/i;

const lev = (a, b) => { const m = a.length, n = b.length, d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]); for (let j = 1; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[m][n]; };
const subseq = (a, b) => { let i = 0; for (const ch of b) if (ch === a[i]) i++; return i === a.length; }; // a's letters appear in b, in order (a letter was missed)
const caseLike = (orig, word) => orig === orig.toUpperCase() && orig.length > 1 ? word.toUpperCase() : /^[A-Z]/.test(orig) ? word[0].toUpperCase() + word.slice(1) : word;

// polish(text, { keep: [words that must stay as typed, e.g. names, places, the ticket subject] })
// → { text, changes: [{ from, to }] }
export function polish(input, { keep = [] } = {}) {
  let t = String(input ?? '').replace(/\r\n?/g, '\n');
  const changes = [], note = (from, to) => { if (from !== to && !changes.some(c => c.from === from && c.to === to)) changes.push({ from, to }); };
  const keepSet = new Set([...CAMPUS_WORDS, ...keep.flatMap(k => String(k || '').toLowerCase().match(/[a-z0-9'.-]+/g) || [])]);
  // emails and links stay exactly as typed (protected before anything else)
  const masks = []; t = t.replace(/(https?:\/\/\S+|www\.\S+|[^\s@]+@[^\s@]+\.[^\s@,;]+)/gi, m => { const tail = /[.,;:!?)]+$/.exec(m)?.[0] || ''; masks.push(m.slice(0, m.length - tail.length)); return `\u0000${masks.length - 1}\u0000${tail}`; });
  // SHOUTING → normal case (only when most of a long note is capitals)
  const letters = t.replace(/[^A-Za-z]/g, ''); if (letters.length >= 12 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7) { t = t.toLowerCase(); note('CAPITALS', 'normal case'); }
  // spacing and repeated punctuation
  const before = t;
  t = t.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').replace(/ +([,.!?;:])/g, '$1').replace(/([!?])\1+/g, '$1').replace(/,{2,}/g, ',').replace(/\.{4,}/g, '...')
    .replace(/([,;:])(?=[A-Za-z])/g, '$1 ').replace(/([.!?])(?=[A-Z][a-z])/g, '$1 ').trim();
  if (t !== before.trim()) note('spacing', 'tidied');
  // words
  t = t.replace(/[A-Za-z][A-Za-z0-9']*/g, (w, off, all) => {
    const lw = w.toLowerCase();
    if (/^\d|\d/.test(w) && !SHORT[lw]) return w; // codes, room numbers
    if (SHORT[lw] && SHORT[lw] !== lw) { const r = lw === 'im' || lw === 'ive' || lw === 'ill' ? SHORT[lw] : caseLike(w, SHORT[lw]); note(w, r); return r; }
    if (lw === 'i') { if (w !== 'I') note('i', 'I'); return 'I'; }
    if (keepSet.has(lw) || w.length < 3 || (w === w.toUpperCase() && w.length <= 6) || spell.correct(w) || spell.correct(lw)) return w;
    if (VOWELLESS.test(w)) return w;
    // best guess: the word with the missed letter(s) put back, else the closest; nothing if none is close enough
    const cands = spell.suggest(lw).map(x => x.toLowerCase()).filter(x => !x.includes(' ') && lev(lw, x) <= (lw.length >= 7 ? 2 : 1));
    const sug = cands.find(x => x.length > lw.length && subseq(lw, x)) || (cands.length === 1 ? cands[0] : null);
    if (!sug) return w;
    const r = caseLike(w, sug); note(w, r); return r;
  });
  // sentences: a capital at the start of each, a full stop at the end of each line
  t = t.split('\n').map(line => {
    if (!line.trim()) return line;
    let l = line.replace(/(^|[.!?]\s+)([a-z])/g, (m, a, b) => a + b.toUpperCase());
    if (/[A-Za-z0-9)]$/.test(l)) l += '.'; // (a line ending in a link or email keeps no full stop: it stays clickable)
    return l;
  }).join('\n').replace(/\u0000(\d+)\u0000/g, (_, i) => masks[+i]);
  if (t.replace(/\s+/g, ' ').toLowerCase() !== String(input ?? '').replace(/\s+/g, ' ').toLowerCase().trim() || t !== String(input ?? '').trim()) {
    if (!changes.length && t !== String(input ?? '').trim()) note('sentences', 'capitals and full stops');
    else if (/^[a-z]/.test(String(input ?? '').trim()) || /[A-Za-z0-9)]$/.test(String(input ?? '').trim())) note('sentences', 'capitals and full stops');
  }
  return { text: t, changes };
}
