// Get the ONE Desk app (PWA) on any phone or computer.
// Android / Chrome / Edge: one tap installs it straight away (the browser's own install prompt).
// iPhone / iPad: Apple has no install prompt, so we show the exact steps for the browser in use (Share → Add to Home Screen).
// Everything else: the steps for that browser. The full guide lives at #/install (link or QR it); a button opens it anywhere.

const ua = navigator.userAgent;
export const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isAndroid = /Android/i.test(ua);
export const isMac = !isIOS && /Macintosh|Mac OS X/.test(ua);
// opened from the home-screen icon: already installed, no button needed
export const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
// iOS browsers: all can add to the Home Screen from iOS 16.4; in-app browsers (WhatsApp, Instagram, Gmail…) cannot
const iosBrowser = /CriOS/.test(ua) ? 'Chrome' : /FxiOS/.test(ua) ? 'Firefox' : /EdgiOS/.test(ua) ? 'Edge'
  : /FBAN|FBAV|Instagram|Line\/|WhatsApp|GSA\//.test(ua) || !/Safari/.test(ua) ? 'in-app' : 'Safari';
const androidBrowser = /SamsungBrowser/.test(ua) ? 'Samsung' : /Firefox/.test(ua) ? 'Firefox' : /; wv\)|FBAN|Instagram|WhatsApp/.test(ua) ? 'in-app' : 'Chrome';

let promptEvt = window.__bip || null; // the browser's install prompt (index.html may have caught it first), kept until the person taps Install
const listeners = new Set();
const changed = () => listeners.forEach(f => f());
addEventListener('beforeinstallprompt', e => { e.preventDefault(); promptEvt = e; changed(); stickyInstall(); });
addEventListener('appinstalled', () => { promptEvt = null; changed(); });
export const canPromptInstall = () => !!promptEvt;
// Android / desktop Chrome: the real install, one tap. Returns true when the person accepted.
export async function installNow() {
  if (!promptEvt) return false;
  const e = promptEvt; promptEvt = null; e.prompt();
  const { outcome } = await e.userChoice.catch(() => ({ outcome: 'dismissed' })); changed(); stickyInstall();
  return outcome === 'accepted';
}

// small pictures of the buttons people look for
const G = {
  share: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#0a84ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1"/></svg>',
  add: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="3" width="18" height="18" rx="4"/><path d="M12 8v8M8 12h8"/></svg>',
  dots: '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>',
  more: '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  menu: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  dl: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7 10l5 5 5-5M5 21h14"/></svg>',
  apple: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></svg>',
  android: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></svg>',
  pc: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
};
const step = (n, html) => `<li><span class="istep">${n}</span><div>${html}</div></li>`;
const ol = steps => `<ol class="isteps">${steps.map((s, i) => step(i + 1, s)).join('')}</ol>`;
const k = t => `<b class="ikey">${t}</b>`;

function iosSteps() {
  const open = '<b>Open this page in Safari</b>. You are in another app’s browser: tap ' + G.more + ' or ' + G.share + ' and choose ' + k('Open in Safari') + ', or copy the link and paste it in Safari.';
  const share = iosBrowser === 'Safari'
    ? `Tap the <b>Share</b> button ${G.share} in the bar at the bottom of the screen (on iPad: top right). Don’t see the bar? Scroll up a little, or tap ${G.more} first.`
    : `Tap the <b>Share</b> button ${G.share} in the address bar at the top right (in ${iosBrowser}, it may be under ${G.more}).`;
  return ol([
    ...(iosBrowser === 'in-app' ? [open] : []),
    share,
    `Scroll down the list and tap ${k(G.add + ' Add to Home Screen')}. Not in the list? Tap ${k('Edit Actions…')} at the bottom and add it.`,
    `Keep ${k('Open as Web App')} switched on (if you see it), check the name says <b>ONE Desk</b>, then tap ${k('Add')} at the top right.`,
    'Find the <b>ONE Desk</b> icon on your Home Screen. Tap it: it opens full screen, like any app.',
  ]) + '<p class="muted small">Needs iOS 16.4 or later for browsers other than Safari. On an older iPhone, use Safari.</p>';
}
function androidSteps() {
  const inst = promptEvt ? `<button type="button" class="btn primary big" data-install-now>${G.dl} Install ONE Desk now</button><p class="muted small" style="text-align:center">One tap. No Play Store, no download to find later.</p>` : '';
  const steps = androidBrowser === 'Samsung' ? [
    `Tap the menu ${G.menu} at the bottom right.`, `Tap ${k('Add page to')}, then ${k('Home screen')}.`, `Tap ${k('Add')}. ONE Desk is now on your home screen.`,
  ] : androidBrowser === 'Firefox' ? [
    `Tap the menu ${G.dots} (top or bottom right).`, `Tap ${k('Install')} (or ${k('Add to Home screen')}).`, `Tap ${k('Add')}. ONE Desk is now on your home screen.`,
  ] : androidBrowser === 'in-app' ? [
    `Open this page in Chrome: tap ${G.dots} at the top right and choose ${k('Open in Chrome')} (or ${k('Open in browser')}).`, 'Then tap <b>Install ONE Desk now</b> on that page, or follow the Chrome steps.',
  ] : [
    `Tap the menu ${G.dots} at the top right of Chrome.`, `Tap ${k('Install app')} (on some phones it says ${k('Add to Home screen')}).`,
    `Tap ${k('Install')}. ONE Desk appears on your home screen and in your app drawer.`,
  ];
  return inst + (inst ? '<p class="muted small" style="margin-top:14px">No button? Do it from the browser menu:</p>' : '') + ol(steps);
}
const nowBtn = () => promptEvt ? `<button type="button" class="btn primary big" data-install-now>${G.dl} Install ONE Desk now</button><p class="muted small" style="text-align:center">One click. Or do it from the browser:</p>` : '';
function desktopSteps() { // Windows, Linux, Chromebook
  return nowBtn() + ol([
    `<b>Chrome</b>: click the install icon ${G.dl} at the right end of the address bar. Or open the menu ${G.dots} → ${k('Cast, save and share')} → ${k('Install page as app')} → ${k('Install')}.`,
    `<b>Edge</b>: open the menu ${G.more} → ${k('Apps')} → ${k('Install this site as an app')} → ${k('Install')}.`,
    'ONE Desk opens in its own window. Find it in the Start menu or on the desktop, and pin it to the taskbar if you like.',
  ]) + '<p class="muted small">Firefox can’t install apps; open this page in Chrome or Edge.</p>';
}
function macSteps() {
  return nowBtn() + ol([
    `<b>Safari</b> (macOS Sonoma 14 or later): click ${k('File')} in the menu bar → ${k('Add to Dock…')} → ${k('Add')}. Or click the Share button ${G.share} → ${k('Add to Dock')}.`,
    `<b>Chrome</b>: click the install icon ${G.dl} at the right end of the address bar, or menu ${G.dots} → ${k('Cast, save and share')} → ${k('Install page as app')}.`,
    `<b>Edge</b>: menu ${G.more} → ${k('Apps')} → ${k('Install this site as an app')}.`,
    'ONE Desk is now in your Dock and in Launchpad / Applications, and opens in its own window.',
  ]);
}

const TABS = [['ios', 'iPhone / iPad', G.apple, iosSteps], ['android', 'Android', G.android, androidSteps], ['mac', 'Mac', G.pc, macSteps], ['desktop', 'Windows / PC', G.pc, desktopSteps]];
export const defaultTab = () => isIOS ? 'ios' : isAndroid ? 'android' : isMac ? 'mac' : 'desktop';
// The guide: a tab per platform (the visitor's own picked), each with its steps.
export function guideHtml(tab = defaultTab(), only = false) {
  if (only) return `<div class="iguide">${TABS.find(t => t[0] === tab)[3]()}<p class="muted small">Another phone or a computer? <a href="#/install" data-close-dlg>See the steps for every device</a>.</p></div>`;
  return `<div class="iguide">${standalone() ? '<div class="iok">✓ You are using the installed ONE Desk app.</div>' : ''}
    <div class="tabs itabs">${TABS.map(([key, label, ic]) => `<button type="button" class="tab ${key === tab ? 'on' : ''}" data-itab="${key}">${ic} ${label}</button>`).join('')}</div>
    <div class="ibody">${TABS.find(t => t[0] === tab)[3]()}</div>
    <p class="muted small">The app is ONE Desk itself: raise and track tickets, or work your queue, with your sign-in kept. It updates on its own and uses almost no space.</p></div>`;
}
// Draw the guide into el and keep it current (tab taps, the install prompt arriving later, Install now).
export function mountGuide(el, onInstalled, only = false) {
  let tab = defaultTab();
  const draw = () => { el.innerHTML = guideHtml(tab, only); };
  el.addEventListener('click', async e => {
    const t = e.target.closest('[data-itab]'); if (t) { tab = t.dataset.itab; return draw(); }
    if (e.target.closest('[data-install-now]') && await installNow()) onInstalled?.();
  });
  const f = () => el.isConnected ? draw() : listeners.delete(f); listeners.add(f);
  draw();
}
// The "Install the app" button: on Android / Chrome it installs in one tap; elsewhere it opens the steps.
export const installBtnHtml = label => standalone() ? '' : `<p style="text-align:center;margin-top:14px"><button type="button" class="btn soft install">${G.dl} ${label || (promptEvt ? 'Install ONE Desk · 1 click' : isIOS ? 'Add ONE Desk to your iPhone' : 'Install ONE Desk app')}</button></p>`;
export function openGuideDialog(toast) {
  const d = document.createElement('dialog'); d.className = 'idlg';
  d.innerHTML = `<div class="idlg-h"><img src="icon-192.png" alt="" width="40" height="40"><div><b>${isIOS ? 'Add ONE Desk to your iPhone' : 'Get the ONE Desk app'}</b><div class="muted small">Free · installs from this page</div></div>
    <button type="button" class="iconbtn" data-close aria-label="Close">✕</button></div><div class="idlg-b"></div>`;
  document.body.append(d); d.showModal(); d.onclose = () => d.remove();
  d.querySelector('[data-close]').onclick = () => d.close();
  d.addEventListener('click', e => { if (e.target.closest('[data-close-dlg]')) d.close(); });
  mountGuide(d.querySelector('.idlg-b'), () => { d.close(); toast?.('ONE Desk installed. Find it on your home screen.'); }, isIOS); // iPhone: its own steps only
}
document.addEventListener('click', async e => {
  if (!e.target.closest('.install')) return;
  if (promptEvt) { await installNow(); return; } // one-tap install (Android, Chrome, Edge); the buttons go once it is installed
  openGuideDialog(window.__toast);
});
// iPhone visitors in the browser get a one-time hint, since iOS never offers to install by itself.
export const iosHintHtml = () => {
  let seen = true; try { seen = localStorage.getItem('ios-hint') === '1'; } catch { /* storage off */ }
  return isIOS && !standalone() && !seen ? `<div class="iosbar"><img src="icon-192.png" alt="" width="36" height="36"><div><b>Add ONE Desk to your Home Screen</b>
    <div class="small">Tap ${G.share} then <b>Add to Home Screen</b>. It opens like an app.</div></div>
    <button type="button" class="btn soft install">How</button><button type="button" class="iconbtn" data-ioshide aria-label="Hide">✕</button></div>` : '';
};
document.addEventListener('click', e => { const b = e.target.closest('[data-ioshide]'); if (!b) return;
  try { localStorage.setItem('ios-hint', '1'); } catch { /* storage off */ } b.closest('.iosbar').remove(); });

// A sticky "Install app" button on every screen, on every device, until ONE Desk runs as the installed app.
// Android / Chrome / Edge: one tap installs. iPhone: its own Add to Home Screen steps. Mac and PC: their steps.
const STICK_LABEL = () => promptEvt ? 'Install app · 1 click' : isIOS ? 'Add to iPhone' : isAndroid ? 'Install app' : isMac ? 'Install on Mac' : 'Install app';
export function stickyInstall() {
  let el = document.querySelector('.istick');
  if (standalone()) { el?.remove(); return; }
  if (!el) { el = document.createElement('button'); el.type = 'button'; el.className = 'istick install'; document.body.append(el); }
  el.innerHTML = `${G.dl}<span>${STICK_LABEL()}</span>`; el.classList.toggle('one', !!promptEvt);
  el.setAttribute('aria-label', 'Install the ONE Desk app');
}
addEventListener('appinstalled', () => { document.querySelectorAll('.istick, .install').forEach(b => (b.closest('p') || b).remove()); });
matchMedia('(display-mode: standalone)').addEventListener?.('change', stickyInstall);
