// Tidy a provider's note before the requester sees it: spelling, common short-forms and sentence form.
// Runs entirely on this server (British English dictionary + the lists below). No API, nothing leaves the machine.
//
// It is deliberately careful: a word is changed only when
//   • it is a known short-form or common misspelling (SHORT below), or
//   • it is not a dictionary word, is at least 5 letters long, and exactly ONE real word is reached by one of four
//     everyday typing slips: a letter doubled by mistake (comming), a double letter typed once (adress), two neighbouring
//     letters swapped (recieve), or a vowel left out inside the word (damged).
// Everything else stays exactly as typed: names (Devi, Reddy, Priya), places, local words (tiffin, garu), codes, emails
// and links. It never guesses "the nearest dictionary word": that turns names into other words.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import nspell from 'nspell';

const require = createRequire(import.meta.url), dictDir = require.resolve('dictionary-en-gb').replace(/index\.js$/, '');
const spell = nspell(fs.readFileSync(dictDir + 'index.aff'), fs.readFileSync(dictDir + 'index.dic'));

// Short-forms and the usual misspellings, mapped to the proper word(s)
export const SHORT = {
  // chat short-forms
  ur: 'your', pls: 'please', plz: 'please', plss: 'please', plzz: 'please', pl: 'please', thx: 'thanks', tnx: 'thanks', thnx: 'thanks', thnks: 'thanks', thanx: 'thanks', ty: 'thank you',
  thanku: 'thank you', thankyou: 'thank you', msg: 'message', mesg: 'message', coz: 'because', cos: 'because', bcoz: 'because', bcz: 'because', bcos: 'because', becoz: 'because', bcse: 'because',
  asap: 'as soon as possible', abt: 'about', wht: 'what', hv: 'have', hav: 'have', ppl: 'people', b4: 'before', tdy: 'today', tmrw: 'tomorrow', tmr: 'tomorrow', tmrrw: 'tomorrow',
  im: "I'm", ive: "I've", dont: "don't", cant: "can't", wont: "won't", didnt: "didn't", doesnt: "doesn't", isnt: "isn't", wasnt: "wasn't", havent: "haven't", hasnt: "hasn't",
  couldnt: "couldn't", shouldnt: "shouldn't", wouldnt: "wouldn't", thats: "that's", whats: "what's", theres: "there's",
  shud: 'should', cud: 'could', wud: 'would', gud: 'good', gd: 'good', grt: 'great', vry: 'very', wen: 'when', whn: 'when', thn: 'then', 
  frm: 'from', wth: 'with', wid: 'with', nt: 'not', smthng: 'something', smthing: 'something', nthng: 'nothing', evry: 'every', evrything: 'everything', alrdy: 'already', alredy: 'already', alrady: 'already',
  stil: 'still', untl: 'until', til: 'till', aftr: 'after', bfr: 'before', btwn: 'between', nxt: 'next', frst: 'first', thru: 'through', gonna: 'going to', wanna: 'want to',
  ok: 'OK', okk: 'OK', kk: 'OK', sry: 'sorry', srry: 'sorry', sory: 'sorry', rply: 'reply', wrk: 'work', wrkng: 'working', wrking: 'working', workng: 'working', woking: 'working', wroking: 'working',
  dne: 'done', recvd: 'received', rcvd: 'received', chk: 'check', chked: 'checked', chkd: 'checked', cmng: 'coming', frnd: 'friend', wich: 'which', hrs: 'hours', mins: 'minutes',
  dept: 'department', govt: 'government', mgmt: 'management', amt: 'amount', qty: 'quantity', approx: 'approximately', info: 'information', evng: 'evening', mrng: 'morning',
  alot: 'a lot', infact: 'in fact', ofcourse: 'of course', atleast: 'at least', incase: 'in case', aswell: 'as well', tubelight: 'tube light', tubelite: 'tube light',
  // common misspellings a typing-slip rule can't reach (a wrong letter, or two slips in one word)
  wil: 'will', wll: 'will', teh: 'the', adn: 'and', taht: 'that', wiht: 'with', tommorow: 'tomorrow', tommorrow: 'tomorrow', tomorow: 'tomorrow', tomoro: 'tomorrow', yesterdy: 'yesterday', tody: 'today',
  recieved: 'received', recieve: 'receive', recived: 'received', recevied: 'received', definately: 'definitely', definatly: 'definitely', seperate: 'separate', seperately: 'separately', untill: 'until',
  occured: 'occurred', occurence: 'occurrence', neccessary: 'necessary', necesary: 'necessary', neccesary: 'necessary', accomodate: 'accommodate', accomodation: 'accommodation', adress: 'address',
  acheive: 'achieve', beleive: 'believe', begining: 'beginning', catagory: 'category', comming: 'coming', commitee: 'committee', completly: 'completely', enviroment: 'environment', existance: 'existence',
  finaly: 'finally', foward: 'forward', goverment: 'government', happend: 'happened', immediatly: 'immediately', immediatley: 'immediately', independant: 'independent', knowlege: 'knowledge', libary: 'library',
  maintainance: 'maintenance', maintanance: 'maintenance', maintenence: 'maintenance', maintainence: 'maintenance', noticable: 'noticeable', occassion: 'occasion', persistant: 'persistent', prefered: 'preferred',
  privelege: 'privilege', probaly: 'probably', realy: 'really', refered: 'referred', relevent: 'relevant', remeber: 'remember', responce: 'response', succesful: 'successful', sucessful: 'successful', successfull: 'successful',
  suprise: 'surprise', truely: 'truly', unfortunatly: 'unfortunately', usefull: 'useful', wierd: 'weird', writting: 'writing', attendence: 'attendance', electrition: 'electrician', electrican: 'electrician',
  plumer: 'plumber', technican: 'technician', technition: 'technician', carpentar: 'carpenter', vender: 'vendor', replacment: 'replacement', instalation: 'installation', conection: 'connection', hostal: 'hostel', hostle: 'hostel',
  cantin: 'canteen', canten: 'canteen', swich: 'switch', tiket: 'ticket', tikcet: 'ticket', problam: 'problem', prblm: 'problem', complant: 'complaint', requst: 'request', reqest: 'request', aproval: 'approval', approvel: 'approval',
  permision: 'permission', compleated: 'completed', complted: 'completed', fixd: 'fixed', repaird: 'repaired', availble: 'available', avaliable: 'available', availabe: 'available', isue: 'issue', welcom: 'welcome',
  plese: 'please', pleas: 'please', plase: 'please', kindy: 'kindly', wating: 'waiting', resloved: 'resolved', reslove: 'resolve', solvd: 'solved', clened: 'cleaned', cleand: 'cleaned', chnaged: 'changed', chnged: 'changed',
};
// Words that are right as they are on a campus (not in the dictionary, never "corrected")
export const CAMPUS_WORDS = ['wifi', 'wi-fi', 'erp', 'lms', 'mcb', 'rccb', 'elcb', 'ups', 'ac', 'acs', 'dg', 'ro', 'cctv', 'ip', 'lan', 'hod', 'hods', 'id', 'ids', 'otp', 'pdf', 'upi', 'neft',
  'choke', 'ballast', 'geyser', 'geysers', 'inverter', 'invertor', 'sump', 'borewell', 'mess', 'canteen', 'hostel', 'hostels', 'warden', 'wardens', 'block', 'lab', 'labs', 'okay', 'ok', 'bpt', 'bot', 'mpt', 'btech', 'mtech',
  'pg', 'ug', 'smru', 'sem', 'viva', 'bonafide', 'hallticket', 'biometric', 'physio', 'opd', 'icu', 'mri', 'tiffin', 'dal', 'sambar', 'chapati', 'chapatis', 'roti', 'idli', 'dosa', 'vada', 'puri', 'upma', 'poha', 'biryani',
  'curd', 'rasam', 'paneer', 'veg', 'nonveg', 'whatsapp', 'gmail', 'outlook', 'teams', 'zoom', 'sir', 'madam', 'garu', 'anna', 'akka', 'ji'];
// "u" and "r" are short for "you" and "are", unless they name a place (R block, block U, room R 12)
const PLACE = new Set(['block', 'blk', 'wing', 'section', 'sec', 'room', 'floor', 'gate', 'tower', 'building', 'bldg', 'hostel', 'lab', 'class', 'div', 'division', 'row', 'hall', 'ward', 'zone', 'phase', 'type', 'grade']);
// Campus abbreviations typed in small letters are shown the usual way
const ACRONYM = { mcb: 'MCB', rccb: 'RCCB', elcb: 'ELCB', erp: 'ERP', lms: 'LMS', cctv: 'CCTV', ac: 'AC', acs: 'ACs', dg: 'DG', ro: 'RO', ip: 'IP', lan: 'LAN', hod: 'HOD', hods: 'HODs', id: 'ID', ids: 'IDs',
  otp: 'OTP', pdf: 'PDF', upi: 'UPI', neft: 'NEFT', icu: 'ICU', mri: 'MRI', opd: 'OPD', pg: 'PG', ug: 'UG', bpt: 'BPT', mpt: 'MPT', smru: 'SMRU', wifi: 'Wi-Fi' };
const VOWELLESS = /^[^aeiouy]+$/i, VOWELS = 'aeiou';

// One everyday typing slip away from exactly one real word (see the top of this file); null if none or more than one.
function slipFix(lw) {
  if (lw.length < 5 || !/^[a-z]+$/.test(lw)) return null;
  const found = new Set(), tryWord = x => { if (found.size < 2 && spell.correct(x)) found.add(x); };
  for (let i = 1; i < lw.length; i++) if (lw[i] === lw[i - 1]) tryWord(lw.slice(0, i) + lw.slice(i + 1)); // comming → coming
  for (let i = 0; i < lw.length; i++) tryWord(lw.slice(0, i + 1) + lw[i] + lw.slice(i + 1)); // adress → address
  for (let i = 0; i < lw.length - 1; i++) if (lw[i] !== lw[i + 1]) tryWord(lw.slice(0, i) + lw[i + 1] + lw[i] + lw.slice(i + 2)); // recieve → receive
  for (let i = 1; i < lw.length; i++) for (const v of VOWELS) tryWord(lw.slice(0, i) + v + lw.slice(i)); // damged → damaged
  return found.size === 1 ? [...found][0] : null;
}
const caseLike = (orig, word) => orig === orig.toUpperCase() && orig.length > 1 ? word.toUpperCase() : /^[A-Z]/.test(orig) ? word[0].toUpperCase() + word.slice(1) : word;

// polish(text, { keep: [words that must stay as typed, e.g. names, places, the ticket subject] })
// → { text, changes: [{ from, to }] }
export function polish(input, { keep = [] } = {}) {
  const raw = String(input ?? '').replace(/\r\n?/g, '\n').trim();
  let t = raw;
  const changes = [], note = (from, to) => { if (from !== to && !changes.some(c => c.from === from && c.to === to)) changes.push({ from, to }); };
  const context = new Set(keep.flatMap(k => String(k || '').toLowerCase().match(/[a-z0-9']+/g) || [])), campus = new Set(CAMPUS_WORDS);
  // emails and links stay exactly as typed (protected before anything else)
  const masks = []; t = t.replace(/(https?:\/\/\S+|www\.\S+|[^\s@]+@[^\s@]+\.[^\s@,;]+)/gi, m => { const tail = /[.,;:!?)]+$/.exec(m)?.[0] || ''; masks.push(m.slice(0, m.length - tail.length)); return `\u0000${masks.length - 1}\u0000${tail}`; });
  // SHOUTING → normal case (only when most of a long note is capitals)
  const letters = t.replace(/[^A-Za-z]/g, ''), shout = letters.length >= 10 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7;
  if (shout) { t = t.toLowerCase(); note('CAPITALS', 'normal case'); }
  // spacing and repeated punctuation
  const before = t;
  t = t.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').replace(/ +([,.!?;:])/g, '$1').replace(/([!?])\1+/g, '$1').replace(/,{2,}/g, ',').replace(/\.{4,}/g, '...')
    .replace(/([,;:])(?=[A-Za-z])/g, '$1 ').replace(/([.!?])(?=[A-Z][a-z])/g, '$1 ').trim();
  if (t !== before) note('spacing', 'tidied');
  // "2day", "2mrw": short-forms that start with a digit
  t = t.replace(/\b2(day|mrw|moro|morrow)\b/gi, (m, x) => { const r = x.toLowerCase() === 'day' ? 'today' : 'tomorrow'; note(m, r); return r; });
  // words
  const tokens = t.match(/[A-Za-z0-9']+/g) || [];
  let ti = -1;
  t = t.replace(/[A-Za-z0-9']+/g, (w, off, all) => {
    ti++;
    if (!/^[A-Za-z]/.test(w)) return w; // numbers, 4pm, 2nd
    const lw = w.toLowerCase(), prev = (tokens[ti - 1] || '').toLowerCase(), next = (tokens[ti + 1] || '').toLowerCase();
    if (w === lw && Object.hasOwn(ACRONYM, lw)) { note(w, ACRONYM[lw]); return ACRONYM[lw]; } // mcb → MCB
    // a single letter after "block", "room", "wing"… is its name: block b → block B ("a" only when it clearly is one: block a room 12)
    if (w.length === 1 && w === lw && lw !== 'i' && PLACE.has(prev) && (lw !== 'a' || shout || PLACE.has(next) || /^\d/.test(next) || /^\s*([.,;:!?)\n]|$)/.test(all.slice(off + 1)))) { note(`${prev} ${w}`, `${prev} ${w.toUpperCase()}`); return w.toUpperCase(); }
    if (context.has(lw)) return w; // a word of this ticket (name, place, subject): as typed
    if (w.length > 1 && w === w.toUpperCase()) return w; // typed in capitals: an abbreviation (HR, IT, PL), as typed
    if (lw === 'u' || lw === 'r') { // you / are, unless it names a place or sits next to a number
      if (w !== lw || PLACE.has(prev) || PLACE.has(next) || /^\d/.test(next) || /\d$/.test(prev)) return w;
      const r = lw === 'u' ? 'you' : 'are'; note(w, r); return r;
    }
    if (lw === 'i') { if (w !== 'I') note('i', 'I'); return 'I'; }
    if (Object.hasOwn(SHORT, lw)) { const r = /^I'/.test(SHORT[lw]) || SHORT[lw] === 'OK' ? SHORT[lw] : caseLike(w, SHORT[lw]); note(w, r); return r; }
    if (/\d/.test(w) || campus.has(lw) || w.length < 3 || VOWELLESS.test(w) || spell.correct(w) || spell.correct(lw)) return w;
    // a capital in the middle of a sentence marks a name: as typed
    const sentenceStart = off === 0 || /[.!?\n]\s*$/.test(all.slice(Math.max(0, off - 3), off));
    if (/^[A-Z]/.test(w) && !sentenceStart) return w;
    const fix = slipFix(lw); if (!fix) return w;
    const r = caseLike(w, fix); note(w, r); return r;
  });
  // sentences: a capital at the start of each, a full stop at the end of each line
  const shaped = t;
  t = t.split('\n').map(line => {
    if (!line.trim()) return line;
    let l = line.replace(/(^|[.!?]\s+)([a-z])/g, (m, a, b) => a + b.toUpperCase());
    if (/[A-Za-z0-9)]$/.test(l)) l += '.'; // (a line ending in a link or email keeps no full stop: it stays clickable)
    return l;
  }).join('\n');
  if (t !== shaped) note('sentences', 'capitals and full stops');
  t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => masks[+i]);
  return { text: t, changes };
}
