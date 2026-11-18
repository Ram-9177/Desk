// Tidy a provider's note before the requester sees it: short forms, everyday typing slips, capitals and full stops.
// Runs entirely on this server from the prepared lists below. No API, no dictionary look-ups, nothing leaves the machine.
//
// It never guesses. A word is changed only when it is
//   • a short form or misspelling in SHORT (written by hand), or
//   • a typing slip in typos.json: one letter left out, two neighbours swapped or a letter doubled in one of the everyday
//     words of a reply (replaced, technician, tomorrow…). That list is built by tools/build-typos.mjs, which leaves out
//     anything that is also a word, a name or a term, or that could have been meant as more than one word.
// Everything else stays exactly as typed: people's names (Chinna, Manish, Wahed), places, brands, local words, anything
// in capitals, and every code: emails, links with or without http, file names, passwords, user names, room and roll
// numbers, abbreviations with dots or slashes (B.Tech, a.m., w.r.t., r/o, a/c).
import fs from 'node:fs';

const TYPOS = JSON.parse(fs.readFileSync(new URL('./typos.json', import.meta.url), 'utf8'));

// Short forms and the usual misspellings, mapped to the proper word(s). None of these is a name or a word with another
// meaning on a campus (that is why "ty", "cos", "wen", "hv", "gd", "gud", "kk" are not here).
export const SHORT = {
  // chat short forms
  ur: 'your', pls: 'please', plz: 'please', plss: 'please', plzz: 'please', thx: 'thanks', tnx: 'thanks', thnx: 'thanks', thnks: 'thanks', thanx: 'thanks', tks: 'thanks', tq: 'thank you', fwd: 'forwarded',
  thanku: 'thank you', thankyou: 'thank you', msg: 'message', mesg: 'message', coz: 'because', bcoz: 'because', bcz: 'because', bcos: 'because', becoz: 'because', bcse: 'because',
  asap: 'as soon as possible', abt: 'about', wht: 'what', hav: 'have', ppl: 'people', tdy: 'today', tmrw: 'tomorrow', tmr: 'tomorrow', tmrrw: 'tomorrow',
  im: "I'm", ive: "I've", dont: "don't", cant: "can't", wont: "won't", didnt: "didn't", doesnt: "doesn't", isnt: "isn't", wasnt: "wasn't", havent: "haven't", hasnt: "hasn't",
  couldnt: "couldn't", shouldnt: "shouldn't", wouldnt: "wouldn't", thats: "that's", whats: "what's", theres: "there's",
  shud: 'should', cud: 'could', wud: 'would', grt: 'great', vry: 'very', whn: 'when', thn: 'then',
  frm: 'from', wth: 'with', wid: 'with', nt: 'not', smthng: 'something', smthing: 'something', nthng: 'nothing', evry: 'every', evrything: 'everything', alrdy: 'already', alredy: 'already', alrady: 'already',
  stil: 'still', untl: 'until', aftr: 'after', bfr: 'before', btwn: 'between', nxt: 'next', frst: 'first', thru: 'through', gonna: 'going to', wanna: 'want to',
  ok: 'OK', okk: 'OK', sry: 'sorry', srry: 'sorry', sory: 'sorry', rply: 'reply', wrk: 'work', wrkng: 'working', wrking: 'working', workng: 'working', woking: 'working', wroking: 'working',
  dne: 'done', recvd: 'received', rcvd: 'received', chk: 'check', chked: 'checked', chkd: 'checked', cmng: 'coming', frnd: 'friend', wich: 'which', hrs: 'hours', mins: 'minutes',
  dept: 'department', govt: 'government', mgmt: 'management', amt: 'amount', qty: 'quantity', approx: 'approximately', info: 'information', evng: 'evening', mrng: 'morning',
  alot: 'a lot', infact: 'in fact', ofcourse: 'of course', atleast: 'at least', incase: 'in case', aswell: 'as well', tubelight: 'tube light', tubelite: 'tube light',
  didnot: 'did not', donot: 'do not', doesnot: 'does not', willbe: 'will be',
  // misspellings a one-letter slip can't explain (a wrong letter, or two slips in one word), and short words
  wil: 'will', wll: 'will', teh: 'the', adn: 'and', taht: 'that', wiht: 'with', tht: 'that', tommorow: 'tomorrow', tommorrow: 'tomorrow', tomorow: 'tomorrow', tomoro: 'tomorrow', tommrow: 'tomorrow', tomorrw: 'tomorrow',
  yesterdy: 'yesterday', yestarday: 'yesterday', yesturday: 'yesterday', tody: 'today', todya: 'today', tonite: 'tonight', woud: 'would', shoud: 'should', coud: 'could',
  becuase: 'because', beacuse: 'because', becasue: 'because', becuse: 'because', thier: 'their', whcih: 'which', thnaks: 'thanks', thansk: 'thanks', thaks: 'thanks', pleae: 'please', plaese: 'please', pelase: 'please', plesae: 'please',
  frist: 'first', agian: 'again', alos: 'also', jsut: 'just', onyl: 'only', anyting: 'anything', somthing: 'something', someting: 'something', beter: 'better', litle: 'little', wheter: 'whether',
  witout: 'without', wihtout: 'without', befor: 'before', bfore: 'before', arround: 'around', accross: 'across',
  recieved: 'received', recieve: 'receive', recived: 'received', recevied: 'received', recieving: 'receiving', definately: 'definitely', definatly: 'definitely', seperate: 'separate', seperately: 'separately', untill: 'until',
  occured: 'occurred', occurence: 'occurrence', neccessary: 'necessary', necesary: 'necessary', neccesary: 'necessary', accomodate: 'accommodate', accomodation: 'accommodation', adress: 'address',
  acheive: 'achieve', beleive: 'believe', begining: 'beginning', catagory: 'category', comming: 'coming', commitee: 'committee', completly: 'completely', enviroment: 'environment', existance: 'existence',
  finaly: 'finally', foward: 'forward', goverment: 'government', happend: 'happened', immediatly: 'immediately', immediatley: 'immediately', imediately: 'immediately', immedately: 'immediately', independant: 'independent', knowlege: 'knowledge', libary: 'library',
  maintainance: 'maintenance', maintanance: 'maintenance', maintenence: 'maintenance', maintainence: 'maintenance', noticable: 'noticeable', occassion: 'occasion', persistant: 'persistent', prefered: 'preferred',
  privelege: 'privilege', probaly: 'probably', realy: 'really', refered: 'referred', relevent: 'relevant', remeber: 'remember', responce: 'response', succesful: 'successful', sucessful: 'successful', successfull: 'successful',
  suprise: 'surprise', truely: 'truly', unfortunatly: 'unfortunately', usefull: 'useful', wierd: 'weird', writting: 'writing', attendence: 'attendance', electrition: 'electrician', electrican: 'electrician', electricain: 'electrician',
  plumer: 'plumber', technican: 'technician', technition: 'technician', tecnician: 'technician', carpentar: 'carpenter', vender: 'vendor', replacment: 'replacement', instalation: 'installation', conection: 'connection', hostal: 'hostel', hostle: 'hostel',
  cantin: 'canteen', canten: 'canteen', swich: 'switch', swtich: 'switch', tiket: 'ticket', tikcet: 'ticket', problam: 'problem', prblm: 'problem', probelm: 'problem', porblem: 'problem', complant: 'complaint', compalint: 'complaint', complait: 'complaint', complint: 'complaint',
  requst: 'request', reqest: 'request', reuqest: 'request', requset: 'request', aproval: 'approval', approvel: 'approval', permision: 'permission', compleated: 'completed', complted: 'completed', compelted: 'completed',
  fixd: 'fixed', repaird: 'repaired', repaierd: 'repaired', repired: 'repaired', availble: 'available', avaliable: 'available', availabe: 'available', avaialble: 'available', availabel: 'available', isue: 'issue', isssue: 'issue', welcom: 'welcome',
  plese: 'please', pleas: 'please', plase: 'please', kindy: 'kindly', kinldy: 'kindly', wating: 'waiting', resloved: 'resolved', reslove: 'resolve', resovled: 'resolved', solvd: 'solved', clened: 'cleaned', cleand: 'cleaned', cleanned: 'cleaned',
  chnaged: 'changed', chnged: 'changed', changd: 'changed', cheked: 'checked', checkd: 'checked', chekced: 'checked', damge: 'damage', ordred: 'ordered', repalced: 'replaced', replced: 'replaced', instaled: 'installed',
  infomed: 'informed', infromed: 'informed', atended: 'attended', vistied: 'visited', visted: 'visited', satrted: 'started', finshed: 'finished', aranged: 'arranged', provied: 'provided', requred: 'required', reqired: 'required',
  purchsed: 'purchased', aproved: 'approved', forwaded: 'forwarded', submited: 'submitted', asigned: 'assigned', sheduled: 'scheduled', schduled: 'scheduled', upadted: 'updated', verifed: 'verified', verfied: 'verified',
  comfirmed: 'confirmed', confimed: 'confirmed', repoted: 'reported', transfered: 'transferred', tranfered: 'transferred', conected: 'connected', esclated: 'escalated', escalted: 'escalated',
  enginer: 'engineer', engneer: 'engineer', enginner: 'engineer', superviser: 'supervisor', oficer: 'officer', offcer: 'officer', studnt: 'student', depatment: 'department', deparment: 'department', ofice: 'office', offce: 'office',
  buiding: 'building', buliding: 'building', bulding: 'building', clasroom: 'classroom', classrom: 'classroom', coridor: 'corridor', bathrom: 'bathroom', toliet: 'toilet', kichen: 'kitchen', windw: 'window', widnow: 'window',
  cuboard: 'cupboard', cupbord: 'cupboard', matress: 'mattress', tabel: 'table', lekage: 'leakage', leakege: 'leakage', bloked: 'blocked', soket: 'socket', ligth: 'light', lihgt: 'light', regulater: 'regulator',
  generater: 'generator', genrator: 'generator', battry: 'battery', batery: 'battery', moter: 'motor', cabel: 'cable', intenet: 'internet', interent: 'internet', netwrk: 'network', netwok: 'network', newtork: 'network',
  pasword: 'password', passwrd: 'password', passowrd: 'password', labtop: 'laptop', computr: 'computer', compter: 'computer', priner: 'printer', projecter: 'projector', sofware: 'software', softwere: 'software',
  sytem: 'system', systm: 'system', keybord: 'keyboard', keybaord: 'keyboard', certifcate: 'certificate', cerificate: 'certificate', certficate: 'certificate', documnt: 'document', docment: 'document',
  aplication: 'application', applicaton: 'application', paymnt: 'payment', payement: 'payment', reciept: 'receipt', recipt: 'receipt', scolarship: 'scholarship', librery: 'library', trasport: 'transport', tranport: 'transport',
  secuirty: 'security', securty: 'security', gaurd: 'guard', medcal: 'medical', docter: 'doctor', ambulence: 'ambulance', claening: 'cleaning', housekeping: 'housekeeping', houskeeping: 'housekeeping', garbge: 'garbage',
  dusbin: 'dustbin', mechine: 'machine', cylender: 'cylinder', brekfast: 'breakfast', breakfst: 'breakfast', qualty: 'quality', quallity: 'quality', hygeine: 'hygiene', hygine: 'hygiene',
  servce: 'service', sevice: 'service', serivce: 'service', suport: 'support', assitance: 'assistance', asistance: 'assistance', infomation: 'information', informtion: 'information', detials: 'details', deatils: 'details',
  urgnt: 'urgent', shorlty: 'shortly', curently: 'currently', inconvinience: 'inconvenience', inconvenence: 'inconvenience', inconveniance: 'inconvenience', inconvience: 'inconvenience',
  appologise: 'apologise', appologies: 'apologies', apolgies: 'apologies', regrads: 'regards', reagrds: 'regards', coperate: 'cooperate', cooprate: 'cooperate', pateince: 'patience', patince: 'patience', paitence: 'patience', patiance: 'patience',
  avilable: 'available', posible: 'possible', possble: 'possible', morining: 'morning', mornig: 'morning', evenig: 'evening', eveing: 'evening', afternon: 'afternoon',
  wensday: 'Wednesday', wednsday: 'Wednesday', wedensday: 'Wednesday', thrusday: 'Thursday', thursady: 'Thursday', tuseday: 'Tuesday', teusday: 'Tuesday', saturdy: 'Saturday', satuday: 'Saturday', firday: 'Friday',
  febuary: 'February', feburary: 'February', septmber: 'September', novmber: 'November', decmber: 'December', januray: 'January',
};
// Campus abbreviations typed in small letters are shown the usual way
const ACRONYM = { mcb: 'MCB', rccb: 'RCCB', elcb: 'ELCB', erp: 'ERP', lms: 'LMS', cctv: 'CCTV', ac: 'AC', acs: 'ACs', dg: 'DG', ro: 'RO', ip: 'IP', lan: 'LAN', hod: 'HOD', hods: 'HODs', id: 'ID', ids: 'IDs',
  otp: 'OTP', pdf: 'PDF', upi: 'UPI', neft: 'NEFT', icu: 'ICU', mri: 'MRI', opd: 'OPD', pg: 'PG', ug: 'UG', bpt: 'BPT', mpt: 'MPT', smru: 'SMRU', wifi: 'Wi-Fi',
  ups: 'UPS', gps: 'GPS', cpu: 'CPU', usb: 'USB', hdmi: 'HDMI', sms: 'SMS', gst: 'GST', ifsc: 'IFSC', utr: 'UTR', noc: 'NOC', kyc: 'KYC', atm: 'ATM', tv: 'TV', pc: 'PC', os: 'OS', tds: 'TDS', dth: 'DTH', amc: 'AMC' };
// A single letter next to one of these names a place: block B, R block, room C 12
const PLACE = new Set(['block', 'blk', 'wing', 'section', 'sec', 'room', 'floor', 'gate', 'tower', 'building', 'bldg', 'hostel', 'lab', 'class', 'div', 'division', 'row', 'hall', 'ward', 'zone', 'phase', 'type', 'grade']);
// Abbreviations: a full stop after one does not end the sentence
const ABBR = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sri', 'smt', 'shri', 'st', 'no', 'nos', 'rs', 'vs', 'etc', 'approx', 'dept', 'govt', 'ext', 'tel', 'ph', 'mob', 'fig', 'sec', 'min', 'hr', 'hrs', 'mins', 'ref',
  'sl', 'sr', 'jr', 'viz', 'ie', 'eg', 'am', 'pm', 'pl', 'dt', 'opp', 'nr', 'co', 'ltd', 'pvt', 'inc', 'univ', 'hon', 'col', 'gen', 'lt', 'capt', 'er', 'adv', 'wef', 'nb', 'ps', 'mgmt', 'amt', 'qty', 'info',
  'addl', 'asst', 'assoc', 'regd', 'admn', 'yr', 'yrs', 'max', 'avg', 'bldg', 'blk', 'flr', 'jt', 'dy', 'edn', 'vol', 'pp', 'pg', 'sq', 'ft', 'kg', 'gm', 'ltr', 'km', 'cm', 'mm', 'incl', 'excl', 'misc', 'temp', 'estd', 'div', 'encl', 'attn', 'sno']);
const TITLE = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sri', 'smt', 'shri', 'er', 'fr', 'br', 'rev', 'md', 'mohd', 'sk', 'ch', 'kum', 'capt', 'col', 'maj', 'lt']);
const HONORIFIC = new Set(['sir', 'madam', 'mam', 'garu', 'ji', 'anna', 'akka', 'bhai', 'saab', 'sahab', 'saheb', 'miss', 'uncle', 'aunty', 'didi', 'bhaiya', 'amma', 'ayya', 'babu']);
// what the end of a web address or a file name looks like: such a word is a link or a file, never a sentence
const TAIL = new Set(['com', 'in', 'org', 'net', 'edu', 'gov', 'ac', 'co', 'io', 'info', 'app', 'ly', 'me', 'biz', 'nic', 'res', 'uk', 'us', 'ai', 'dev', 'tech', 'online', 'site', 'page', 'link',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'jpg', 'jpeg', 'png', 'gif', 'zip', 'txt', 'csv', 'mp4', 'mp3', 'apk', 'exe', 'html', 'htm', 'json', 'xml']);
// "r" is "are" and "u" is "you" only where the sentence shows it; otherwise a lone r or u is an initial (R Suresh) or a block
const R_PREV = new Set(['we', 'you', 'u', 'they', 'there', 'these', 'those', 'what', 'where', 'how', 'who', 'why', 'when', 'which', 'things', 'items', 'students', 'people', 'all', 'both']);
const R_PRON = new Set(['u', 'you', 'we', 'they']);
const R_NEXT = new Set(['not', 'these', 'those', 'there', 'here', 'in', 'on', 'at', 'the', 'ready', 'available', 'pending', 'different', 'also', 'still', 'now', 'already', 'being', 'given', 'taken', 'done', 'sent', 'kept', 'told',
  'seen', 'made', 'paid', 'shown', 'uploaded', 'updated', 'issued', 'released', 'displayed', 'attached', 'added', 'changed', 'replaced', 'repaired', 'fixed', 'closed', 'open', 'opened', 'working', 'coming', 'going', 'waiting',
  'checking', 'trying', 'looking', 'getting', 'having', 'facing', 'expecting', 'requested', 'informed', 'advised', 'asked', 'allowed', 'required', 'supposed', 'sorry', 'happy', 'unable', 'able', 'fine', 'ok', 'good', 'correct',
  'wrong', 'same', 'all', 'both', 'very', 'too', 'so', 'under', 'with', 'from', 'for', 'of', 'to', 'yet', 'only', 'fully', 'completely', 'more', 'less', 'most', 'many']);
const U_NEXT = new Set(['can', 'will', 'r', 'are', 'have', 'had', 'need', 'want', 'may', 'must', 'should', 'could', 'would', 'pls', 'plz', 'please', 'get', 'got', 'come', 'came', 'did', 'do', 'dont', "don't", 'cant', "can't",
  'were', 'wont', "won't", 'shall', 'also', 'too', 'soon', 'later', 'tomorrow', 'tmrw', 'today', 'now', 'again', 'back', 'not', 'know', 'see', 'said', 'asked', 'told', 'gave', 'give', 'wait', 'check', 'collect', 'contact',
  'call', 'visit', 'bring', 'submit', 'pay', 'raised', 'reported', 'mentioned', 'requested']);
const U_PREV = new Set(['thank', 'thanks', 'inform', 'informed', 'tell', 'told', 'call', 'called', 'contact', 'see', 'help', 'request', 'requested', 'to', 'for', 'with', 'if', 'when', 'can', 'will', 'shall', 'may', 'could',
  'would', 'should', 'do', 'did', 'r', 'are', 'were', 'have', 'hope', 'meet', 'give', 'send', 'update', 'let', 'ask', 'asked', 'remind', 'shift', 'wish', 'thanking', 'informing', 'requesting', 'helping', 'calling', 'updating', 'giving', 'sending']);
const U_AFTER = new Set(['to', 'for', 'in', 'on', 'at', 'by', 'the', 'a', 'an', 'your', 'ur', 'about', 'regarding', 'once', 'when', 'after', 'before', 'as', 'that', 'if', 'soon', 'later', 'tomorrow', 'today', 'now', 'again',
  'back', 'sir', 'madam', 'and', 'or', 'so', 'but', 'also', 'too', 'please', 'pls', 'with', 'from', 'this', 'it', 'all', 'shortly', 'immediately']);
// "til 5 pm", "til tomorrow": till. ("til" alone is sesame.)
const TIME = new Set(['today', 'tomorrow', 'tmrw', 'tonight', 'evening', 'morning', 'noon', 'afternoon', 'night', 'now', 'then', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'mon', 'tue', 'wed',
  'thu', 'fri', 'sat', 'sun', 'next', 'further', 'date', 'end', 'week', 'month', 'yesterday', 'lunch', 'dinner', 'completion']);
// an abbreviation written out no longer needs its dot: "approx. 2 days" → "approximately 2 days"
const DOTTED = new Set(['approx', 'dept', 'govt', 'mgmt', 'amt', 'qty', 'info', 'hrs', 'mins', 'msg']);
// a line like this ends a note: what follows is a signature (name, post, phone), not sentences
const CLOSING = /^(thanks|thank you|thanking you|regards|warm regards|best regards|kind regards|with regards|thanks (&|and) regards|thanks (&|and) best regards|yours (sincerely|faithfully|truly))[\s,.!]*$/i;

const caseLike = (orig, word) => orig === orig.toUpperCase() && orig.length > 1 ? word.toUpperCase() : /^[A-Z]/.test(orig) ? word[0].toUpperCase() + word.slice(1) : word;
const isWord = s => /^[A-Za-z]+('[A-Za-z]+)?$/.test(s);
// One piece of the note between spaces: what it is. Only plain words are ever changed.
function kindOf(core) {
  if (!core) return 'none';
  if (isWord(core)) return 'word';
  if (/^[A-Za-z]{2,}[,;:][A-Za-z]{2,}$/.test(core)) return 'join'; // "fan,light", "Note:please": a space is missing
  const dot = /^([A-Za-z][a-z]{2,})\.([A-Za-z][a-z]+)$/.exec(core); // "done.please": a space is missing after the full stop
  if (dot && !TAIL.has(dot[2].toLowerCase()) && !ABBR.has(dot[1].toLowerCase())) return 'stop';
  if (/^[A-Za-z]{3,}(\/[A-Za-z]{3,})+$/.test(core)) return 'slash'; // "fan/light": words, one after another
  return 'code'; // anything with a digit, @, _, a dot, a slash, a hyphen…: as typed
}
const linkLike = core => /@|:\/\/|^www\./i.test(core) || (/^[^\s/]+\.[A-Za-z]{2,6}(\/\S*)?$/.test(core) && TAIL.has(/\.([A-Za-z]{2,6})(\/\S*)?$/.exec(core)[1].toLowerCase()));

// polish(text, { keep: [words that must stay as typed: the requester's name, the place, the team] }) → { text, changes: [{ from, to }] }
export function polish(input, { keep = [] } = {}) {
  const raw = (typeof input === 'string' ? input : input == null ? '' : String(input)).replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim();
  const changes = [], note = (from, to) => { if (from !== to && !changes.some(c => c.from === from && c.to === to)) changes.push({ from, to }); };
  const context = new Set(keep.flatMap(k => String(k || '').toLowerCase().match(/[a-z']{3,}/g) || []).filter(w => !Object.hasOwn(SHORT, w) && !Object.hasOwn(TYPOS, w)));
  // a note typed all in capitals stays in capitals (lower case would lose names, initials and codes); its words are still corrected
  const letters = raw.replace(/[^A-Za-z]/g, ''), shout = letters.length >= 10 && letters.replace(/[^A-Z]/g, '').length / letters.length > 0.7;
  // spacing and repeated punctuation
  let t = raw.replace(/[ \t ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').replace(/ +([,.!?;:])(?=\s|$)/g, '$1').replace(/([!?])\1+/g, '$1').replace(/,{2,}/g, ',').replace(/\.{4,}/g, '...')
    .replace(/(\d) ?: ?(\d{2})(?!\d)/g, '$1:$2'); // "5 : 30 pm"
  if (t !== raw) note('spacing', 'tidied');

  let closing = false, shaped = false;
  const lines = t.split('\n').map((line, li) => {
    if (!line.trim()) return line;
    // the pieces of the line; a piece with a missing space ("fan,light", "done.please") becomes two
    const toks = [];
    for (const chunk of line.split(' ')) {
      const lead = /^[("'“‘[{]*/.exec(chunk)[0], tail = /[)"'”’\]}.,;:!?]*$/.exec(chunk.slice(lead.length))[0], core = chunk.slice(lead.length, chunk.length - tail.length), kind = kindOf(core);
      if (kind === 'join' || kind === 'stop') { const m = /^([A-Za-z]+)([,;:.])([A-Za-z]+)$/.exec(core); note('spacing', 'tidied');
        toks.push({ lead, core: m[1], tail: m[2], kind: 'word' }, { lead: '', core: m[3], tail, kind: 'word' }); }
      else toks.push({ lead, core, tail, kind });
    }
    const low = i => (toks[i]?.core || '').toLowerCase();
    // the word before / after, when nothing but a space lies between
    const prevOf = i => i > 0 && !toks[i - 1].tail && !toks[i].lead ? low(i - 1) : '', nextOf = i => i < toks.length - 1 && !toks[i].tail && !toks[i + 1].lead ? low(i + 1) : '';
    const endsSentence = i => /[.!?]$/.test(toks[i].tail) && !/\.\.\.$/.test(toks[i].tail) && !(toks[i].tail.startsWith('.') && (ABBR.has(low(i)) || /^[A-Za-z]$/.test(toks[i].core) || (toks[i].kind === 'code' && /^[A-Za-z.]+$/.test(toks[i].core))));
    // where the first sentence of the line starts: after a bullet or a list number, if there is one
    let first = 0; while (first < toks.length - 1 && (toks[first].kind === 'none' || /^[-*•–—>·]+$/.test(toks[first].core) || (/^(\d{1,2}|[a-z])$/i.test(toks[first].core) && /^[.)]$/.test(toks[first].tail)))) first++;
    const starts = i => i === first || (i > 0 && endsSentence(i - 1));

    const fix = (w, i) => {
      const lw = w.toLowerCase(), prev = prevOf(i), next = nextOf(i), atEnd = !next, put = r => { note(w, r); return r; };
      if (w.length === 1) {
        if (lw === 'i') return w === 'I' || /^[.)]/.test(toks[i].tail) || toks[i].lead.includes('(') ? w : put('I'); // "i)" and "(i)" number a list
        if (w !== lw) return w;
        if (lw === 'r' && (R_PREV.has(prev) || R_PRON.has(next) || (prev && R_NEXT.has(next) && !PLACE.has(prev) && !TITLE.has(prev)))) return put('are'); // "fans r working"; "block r" and "Mr r …" are not
        if (lw === 'u' && (prev === 'r' || prev === 'are' || prev === 'thank' || U_NEXT.has(next) || (U_PREV.has(prev) && (atEnd || U_AFTER.has(next))))) return put('you');
        if (PLACE.has(prev)) { // "block b", "room c 12"; a, u, r and n are also words, so only where nothing else can be meant
          const plain = /^\d+$/.test(next), sure = lw === 'a' ? (atEnd || plain || (PLACE.has(next) && /^\d/.test(low(i + 2)))) : 'urn'.includes(lw) ? (atEnd || plain || PLACE.has(next)) : true;
          if (sure) { note(`${prev} ${w}`, `${prev} ${w.toUpperCase()}`); return w.toUpperCase(); } }
        if (PLACE.has(next) && !'ain'.includes(lw)) { note(`${w} ${next}`, `${w.toUpperCase()} ${next}`); return w.toUpperCase(); } // "r block", "c wing"
        return w;
      }
      // mcb → MCB ("pg 12" is a page); also "Ac", "Wifi" as a phone writes them at the start of a sentence
      if ((w === lw || (/^[A-Z][a-z]+$/.test(w) && starts(i) && !/^[A-Z]/.test(toks[i + 1]?.core || ''))) && Object.hasOwn(ACRONYM, lw) && !(lw === 'pg' && /^\d/.test(next))) return put(ACRONYM[lw]);
      if (context.has(lw)) return w; // a word of this ticket (the requester's name, the place): as typed
      const caps = w === w.toUpperCase();
      if (caps && !shout) return w; // typed in capitals: an abbreviation (HR, IT, PL), as typed
      // a capital inside a sentence marks a name; so does a capitalised word followed by another one ("Wen Li", "Ty BPT")
      if (!caps && /^[A-Z]/.test(w) && (!starts(i) || /^[A-Z]/.test(toks[i + 1]?.core || ''))) return w;
      if (lw === 'pl') return (starts(i) || /[,;]$/.test(toks[i - 1]?.tail || '')) && toks[i + 1]?.kind === 'word' ? put(caseLike(w, 'please')) : w; // "pl. collect"; in "apply pl for 2 days" it is a kind of leave
      if (lw === 'til') return /^\d/.test(next) || TIME.has(next) ? put(caseLike(w, 'till')) : w;
      if (Object.hasOwn(SHORT, lw)) return put(/^I'/.test(SHORT[lw]) || SHORT[lw] === 'OK' || /^[A-Z]/.test(SHORT[lw]) ? SHORT[lw] : caseLike(w, SHORT[lw]));
      // typing slips: only in a word typed all in small letters (a capital may be a name), and never beside "sir", "garu", "Mr"…
      if ((w === lw || shout) && Object.hasOwn(TYPOS, lw) && !HONORIFIC.has(next) && !TITLE.has(prev)) return put(caseLike(w, TYPOS[lw]));
      return w;
    };
    toks.forEach((k, i) => {
      if (k.kind === 'word') {
        const was = k.core; k.core = fix(k.core, i);
        // "approx. 2 days", "dept. will call": written out, the abbreviation's dot goes (unless a new sentence follows)
        if (k.core !== was && k.tail === '.' && (DOTTED.has(was.toLowerCase()) || was.toLowerCase() === 'pl') && i < toks.length - 1 && (/^[a-z]/.test(toks[i + 1].core) || (was.toLowerCase() === 'approx' && /^\d/.test(toks[i + 1].core)))) k.tail = '';
      } else if (k.kind === 'slash') k.core = k.core.split('/').map(p => { const lp = p.toLowerCase(), r = p === lp && Object.hasOwn(SHORT, lp) ? SHORT[lp] : p === lp && Object.hasOwn(TYPOS, lp) ? TYPOS[lp] : p; note(p, r); return r; }).join('/');
      else if (k.kind === 'code') {
        const lc = k.core.toLowerCase(), m = /^2(day|mrw|moro|morrow)$/.exec(lc);
        if (m) { const r = m[1] === 'day' ? 'today' : 'tomorrow'; note(k.core, r); k.core = r; k.kind = 'word'; }
        else if (lc === 'b4' && k.core === lc && !PLACE.has(prevOf(i)) && !PLACE.has(nextOf(i)) && nextOf(i)) { note('b4', 'before'); k.core = 'before'; k.kind = 'word'; } // "b4 8pm"; "room b4" is a room
        else if (lc === 'wi-fi' && k.core === lc) { note(k.core, 'Wi-Fi'); k.core = 'Wi-Fi'; }
      }
    });
    // sentences: a capital at the start of each, a full stop at the end of the line. Not in a signature (after "Regards,"),
    // and never on a link, an email, a file name or a line that is only a phone number.
    if (li > 0 && CLOSING.test(line.trim())) closing = true;
    if (!closing) {
      // (a short word without a vowel is an abbreviation: "hv panel" starts "HV panel", not "Hv panel")
      toks.forEach((k, i) => { if (k.kind === 'word' && /^[a-z][a-z' ]*$/.test(k.core) && starts(i) && !k.lead.includes('(')) {
        k.core = /^[^aeiouy]{2,4}$/.test(k.core) && !ABBR.has(k.core) && !TITLE.has(k.core) && !/^(h+m+|m+|s+h+|z+|brr+|grr+|tsk|nth|cc)$/.test(k.core) ? k.core.toUpperCase() : k.core[0].toUpperCase() + k.core.slice(1); shaped = true; } });
      const last = toks[toks.length - 1], nameLine = li > 0 && toks.length <= 3 && toks.every(k => !k.tail && /^[A-Z][a-z]+$/.test(k.core)), phone = /^[\d\s+()-]+$/.test(line);
      // (a password, a user name or a link at the end keeps no full stop: the dot would look like part of it)
      const secret = last.kind === 'code' && /[@_=#$%&*~^|\\]/.test(last.core);
      if (/[A-Za-z0-9]$/.test(last.core) && /^\)?$/.test(last.tail) && !linkLike(last.core) && !secret && !nameLine && !phone) { last.tail += '.'; shaped = true; }
    }
    return toks.map(k => k.lead + k.core + k.tail).join(' ');
  });
  if (shaped) note('sentences', 'capitals and full stops');
  return { text: lines.join('\n'), changes };
}
