// Builds typos.json: everyday typing slips of the words providers use in replies, each mapped to the word that was meant.
//   node tools/build-typos.mjs
// The reply clean-up (polish.js) only ever applies corrections from prepared lists: its own short-form list, and this one.
// It never guesses the nearest dictionary word, because that turns names into other words (Chinna → China, Manish → Mannish).
//
// How an entry gets in: take a word from VOCAB below (6+ letters), and make the slips people type: one letter left out,
// two neighbouring letters swapped, one letter doubled. A slip is kept only when
//   • it has at least 6 letters,
//   • it is not itself a word (lower case or as a name) in the dictionary,
//   • it is not in tools/never-touch.txt (people's names, places, brands, campus and medical terms),
//   • undoing a slip of the same kinds leads back to exactly ONE dictionary word (so "wating" is out: waiting / wanting / wasting).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import nspell from 'nspell';

const here = path.dirname(fileURLToPath(import.meta.url)), require = createRequire(import.meta.url), dictDir = require.resolve('dictionary-en-gb').replace(/index\.js$/, '');
const spell = nspell(fs.readFileSync(dictDir + 'index.aff'), fs.readFileSync(dictDir + 'index.dic'));
const VOCAB = `
checked checking cleaned cleaning changed changing replaced replacing replacement repaired repairing repair damaged damage ordered ordering installed installing installation
received receiving informed informing attended attending visited visiting completed completing complete completely resolved resolving started starting finished finishing arranged
arranging arrangement provided providing provide required requires requirement delivered delivering delivery purchased purchasing purchase approved approval approve forwarded
forwarding forward submitted submitting submit assigned assigning scheduled schedule postponed cancelled cancel updated updating update verified verifying verify confirmed
confirming confirm noticed reported reporting report requested requesting request transferred transfer connected connecting connection disconnected restored restore tightened
adjusted adjust inspected inspection serviced service servicing escalated working worked waiting coming arriving arrived reached reaching collect collected collecting collection
contact contacted contacting discuss discussed discussion explain explained mentioned mention expected expect planned planning prepare prepared process processed processing proceed
continue continued consider considered include included including increase increased reduce reduced remove removed removing return returned returning refund refunded release
released renewed renewal review reviewed select selected shifted shifting supply supplied support supported tested testing trying turned switch switched switching opened closed
closing locked unlocked blocked cleared clearing covered created deleted entered extend extended extension failed failure fitted fitting fixing follow followed following handed
handle handled handling happen happened helped improve improved inform issued issuing joined looked looking missing missed needed observe observed obtain obtained occupied operate
operated operating operation painted painting passed placed raised raising reason record recorded refill refilled register registered registration regret reject rejected remain
remains remind reminder reopen reopened repeat repeated replied respond responded response result resume resumed shared showing signed solved sorted spoken stopped stored taking
talked wanted washed washing
technician electrician plumber carpenter engineer supervisor manager officer warden student students faculty department office building classroom corridor bathroom washroom toilet
kitchen window furniture cupboard mattress leakage drainage socket regulator stabiliser generator battery wiring internet network router password laptop computer printer
projector software system keyboard screen certificate document documents application payment receipt scholarship library transport driver timing timings security medical doctor
ambulance housekeeping garbage dustbin machine cylinder breakfast dinner quality quantity hygiene complaint complaints problem problems services assistance solution information
details urgent immediately immediate shortly currently already inconvenience apologise apologies regards kindly cooperate cooperation patience understand understanding available
availability possible tomorrow yesterday morning evening afternoon tonight material materials vendor supplier contractor labour workers worker maintenance electrical plumbing
carpentry sanitation canteen hostel hostels campus college university examination semester results admission attendance timetable classes lecture lectures session sessions
practical internal external project projects assignment submission deadline signature letter letters notice notices circular message messages mobile number numbers address
location ground second middle corner entrance outside inside between behind beside opposite around during before because should please thanks welcome further another everything
everyone anything something nothing always within without through though although however therefore instead either neither whether almost enough really simply mostly mainly
usually normal normally proper properly clearly quickly slowly safely directly exactly finally recently presently regularly temporary temporarily permanent permanently alternate
alternative additional necessary important different difficult sufficient insufficient pending progress status priority emergency condition conditions position section sections
branch centre central common private general special separate several single double entire partial partially minimum maximum average amount balance charges charge deposit
invoice budget sanction sanctioned permission permitted allowed allotted allotment eligible eligibility mandatory optional original duplicate photocopy verification identity
account accounts transaction online offline portal website signal coverage charger device devices monitor display speaker speakers camera cameras sensor scanner
stationery cartridge benches chairs tables lights breaker earthing voltage current neutral capacitor compressor condenser cooling heating heater cooler fridge freezer purifier
filter filters dispenser bottle bottles bucket buckets pipeline washer flushing shower mirror ceiling plaster cracks seepage dampness polish hinges curtain curtains carpet pillow
blanket laundry uniform vehicle vehicles parking pickup routes conductor diesel petrol puncture breakdown accident injury injured treatment medicine medicines tablet tablets
dressing bandage appointment consultation physiotherapy therapy exercise equipment instrument instruments wheelchair stretcher oxygen gloves cleanliness sweeping mopping dusting
mosquito mosquitoes fogging spraying pesticide patrol visitor visitors footage incident stolen property belongings wallet served serving cooked cooking vegetable vegetables
chicken snacks drinking glasses plates spoons
`.split(/\s+/).filter(Boolean);

const never = new Set(fs.readFileSync(path.join(here, 'never-touch.txt'), 'utf8').split(/\s+/).filter(Boolean).map(w => w.toLowerCase()));
const isWord = w => spell.correct(w) || spell.correct(w[0].toUpperCase() + w.slice(1));
const slips = w => { const out = new Set();
  for (let i = 1; i < w.length; i++) out.add(w.slice(0, i) + w.slice(i + 1)); // a letter left out (never the first)
  for (let i = 1; i < w.length - 1; i++) if (w[i] !== w[i + 1]) out.add(w.slice(0, i) + w[i + 1] + w[i] + w.slice(i + 2)); // two neighbours swapped
  for (let i = 1; i < w.length; i++) out.add(w.slice(0, i + 1) + w[i] + w.slice(i + 1)); // a letter doubled (never the first)
  out.delete(w); return [...out]; };
// every dictionary word a slip could have come from
const origins = v => { const out = new Set(), tryIt = x => { if (x !== v && spell.correct(x)) out.add(x); };
  for (let i = 1; i <= v.length; i++) for (const c of 'abcdefghijklmnopqrstuvwxyz') tryIt(v.slice(0, i) + c + v.slice(i));
  for (let i = 0; i < v.length - 1; i++) if (v[i] !== v[i + 1]) tryIt(v.slice(0, i) + v[i + 1] + v[i] + v.slice(i + 2));
  for (let i = 1; i < v.length; i++) if (v[i] === v[i - 1]) tryIt(v.slice(0, i) + v.slice(i + 1));
  return out; };

const bad = VOCAB.filter(w => w.length < 6 || !/^[a-z]+$/.test(w) || !spell.correct(w));
if (bad.length) { console.error('Not usable (under 6 letters or not in the dictionary):', bad.join(' ')); process.exit(1); }
const map = {}, dropped = { word: 0, never: 0, unclear: 0 };
for (const w of [...new Set(VOCAB)]) for (const v of slips(w)) {
  if (v.length < 6) continue; // shorter slips are too easily somebody's name (Wahed, Sumit)
  if (isWord(v)) { dropped.word++; continue; }
  if (never.has(v)) { dropped.never++; console.error('  name or term, left alone:', v, '(would have become', w + ')'); continue; }
  const from = origins(v); if (from.size !== 1 || !from.has(w)) { dropped.unclear++; continue; }
  map[v] = w;
}
const keys = Object.keys(map).sort();
fs.writeFileSync(path.join(here, '..', 'typos.json'), '{\n' + keys.map(k => `${JSON.stringify(k)}:${JSON.stringify(map[k])}`).join(',\n') + '\n}\n');
console.log(`typos.json: ${keys.length} slips of ${new Set(VOCAB).size} words (left out: ${dropped.word} real words, ${dropped.never} names or terms, ${dropped.unclear} that could be more than one word)`);
