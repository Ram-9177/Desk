// Food & catering. Students rate a meal (feedback: no ticket; it feeds the kitchen's scores, charts and reports) or
// report a serious problem (a complaint: a normal ONE Desk ticket for the food service, with the usual duplicate merge).
// Wired from server.js, which passes in its routers and helpers.
import crypto from 'node:crypto';
import { one, all, run, insert, uid, now } from './db.js';
import { dayIn } from './merge.js';
import { kindOf } from './images.js';
import { chartPng } from './chart.js';
import { MEALS, MEAL_NAMES, MEAL_COLORS, FOOD_CHIPS, FOOD_CATEGORIES, CATEGORY_CHIPS, DEFAULT_MEAL_WINDOWS, mealAt, foodCategory } from './public/shared.js';

const HM = /^([01]\d|2[0-3]):[0-5]\d$/, YMD = /^\d{4}-\d{2}-\d{2}$/;
const str = (v, max) => String(v ?? '').trim().slice(0, max);
const localHM = (tz, d = new Date()) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
const addDays = (ymd, n) => { const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const avg = a => a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null;
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const mealWindows = async tid => ({ ...DEFAULT_MEAL_WINDOWS,
  ...Object.fromEntries((await all('SELECT meal, start_time, end_time FROM meal_windows WHERE tenant_id=?', tid)).map(r => [r.meal, [r.start_time, r.end_time]])) });
export const foodService = tid => one(`SELECT * FROM services WHERE tenant_id=? AND is_active=1 AND form_schema::jsonb->>'form_type'='food' ORDER BY sort_order, name LIMIT 1`, tid);

// ---------- aggregation (dashboard and reports share it) ----------
export async function feedbackIn(tid, from, to, location) {
  return all(`SELECT f.*, l.name location FROM food_feedback f LEFT JOIN food_locations l ON l.id=f.location_id
    WHERE f.tenant_id=? AND f.meal_date>=? AND f.meal_date<=? ${location ? 'AND f.location_id=?' : ''} ORDER BY f.created_at DESC`, tid, from, to, ...(location ? [location] : []));
}
const topChips = (rows, n = 3) => Object.entries(rows.flatMap(r => r.chips || []).reduce((m, c) => (m[c] = (m[c] || 0) + 1, m), {}))
  .sort((a, b) => b[1] - a[1]).slice(0, n).map(([chip, count]) => ({ chip, count }));
export function summarize(rows, from, to) {
  const rated = rows.filter(r => r.rating != null), days = [];
  for (let d = from; d <= to && days.length < 400; d = addDays(d, 1)) days.push(d);
  const perMeal = Object.fromEntries(MEALS.map(m => { const r = rated.filter(x => x.meal === m);
    return [m, { avg: avg(r.map(x => x.rating)), count: r.length, chips: topChips(rows.filter(x => x.meal === m)) }]; }));
  return {
    from, to, total: rows.length, rated: rated.length, avg: avg(rated.map(r => r.rating)), per_meal: perMeal, days,
    series: Object.fromEntries(MEALS.map(m => [m, days.map(d => avg(rated.filter(r => r.meal === m && r.meal_date === d).map(r => r.rating)))])),
    rating_counts: Object.fromEntries(MEALS.map(m => [m, [1, 2, 3, 4, 5].map(s => rated.filter(r => r.meal === m && r.rating === s).length)])),
    chips: topChips(rows, FOOD_CHIPS.length),
    comments: rows.filter(r => r.comment).slice(0, 30).map(r => ({ at: r.created_at, meal: r.meal, rating: r.rating, location: r.location, comment: r.comment, name: r.requester_name, converted: r.converted_from_complaint })),
  };
}

export function food(d) {
  const { app, P, S, wrap, bad, notFound, HttpErr, limit, tenantBySlug, createTicket, tenantRow, base, sendMail, SECRET, getSettings, providersFor } = d;
  const tzOf = tn => tn.timezone || 'Asia/Kolkata';

  // ---------- public: what the food screens need ----------
  P.get('/:slug/food', wrap(async req => {
    const tn = await tenantBySlug(req.params.slug), svc = await foodService(tn.id), w = await mealWindows(tn.id);
    return { service: svc ? { id: svc.id, code: svc.code, name: svc.name } : null, windows: w, meal_now: mealAt(w, localHM(tzOf(tn))),
      locations: await all('SELECT id, name FROM food_locations WHERE tenant_id=? AND active=1 ORDER BY sort_order, name', tn.id),
      meals: MEALS, chips: FOOD_CHIPS, categories: FOOD_CATEGORIES };
  }));
  const checkLocation = async (tn, id) => {
    const any = await one('SELECT 1 AS x FROM food_locations WHERE tenant_id=? AND active=1 LIMIT 1', tn.id);
    if (!id) { if (any) throw bad('Please pick the mess / canteen'); return null; }
    const l = await one('SELECT id, name FROM food_locations WHERE id=? AND tenant_id=? AND active=1', id, tn.id); if (!l) throw bad('Please pick the mess / canteen'); return l;
  };
  const checkMeal = m => { if (!MEALS.includes(m)) throw bad('Please pick the meal'); return m; };

  // Rate your meal: feedback only, never a ticket. One rating per meal per device a day.
  P.post('/:slug/food/feedback', wrap(async req => {
    const tn = await tenantBySlug(req.params.slug), b = req.body || {};
    if (b.website) throw bad('Rejected'); // honeypot
    limit('ff:' + req.ip, 120);
    const converted = b.converted_from_complaint === true, meal = checkMeal(b.meal), loc = await checkLocation(tn, b.location_id);
    const rating = b.rating == null || b.rating === '' ? null : Number(b.rating);
    if (rating == null ? !converted : !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) throw bad('Please tap 1 to 5 stars');
    const chips = Array.isArray(b.chips) ? [...new Set(b.chips.map(String))] : [];
    if (chips.some(c => !FOOD_CHIPS.includes(c))) throw bad('Pick from the listed choices');
    const comment = str(b.comment, 1000); if (comment.length > 300) throw bad('Comment: at most 300 characters');
    if (converted && !comment && !chips.length && rating == null) throw bad('Write what happened');
    const device = /^[A-Za-z0-9_-]{8,64}$/.test(b.device_key || '') ? b.device_key : null;
    try {
      await insert('food_feedback', { id: uid(), tenant_id: tn.id, location_id: loc?.id, meal, rating, chips, comment: comment || null, requester_name: str(b.name, 80) || null,
        device_key: device, meal_date: dayIn(tzOf(tn), now()), converted_from_complaint: converted, created_at: now() });
    } catch (e) { if (e.code === '23505') throw new HttpErr(409, 'ALREADY_RATED', `You already rated ${MEAL_NAMES[meal].toLowerCase()} today. Thank you!`); throw e; }
    return { ok: true, message: 'Thanks! Your rating reaches the Executive Chef tonight.' };
  }));

  // Report a serious problem: a normal ticket for the food service (duplicate merge by place + category), photo required
  P.post('/:slug/food/complaint', wrap(async req => {
    const tn = await tenantBySlug(req.params.slug), b = req.body || {}, svc = await foodService(tn.id);
    if (!svc) throw notFound();
    if (b.website) throw bad('Rejected');
    limit('ip:' + req.ip, 300); limit('c:' + (b.email || b.phone || ''), 12);
    const meal = checkMeal(b.meal), loc = await checkLocation(tn, b.location_id);
    if (!FOOD_CATEGORIES.some(c => c[0] === b.category)) throw bad('Please pick what the problem is');
    const description = str(b.description, 2000); if (!description) throw bad('Please describe the problem');
    const files = Array.isArray(b.files) ? b.files : [];
    if (!files.length) throw bad('Please add a photo of the problem');
    for (const f of files) if (!['jpeg', 'png', 'gif', 'webp', 'heic'].includes(kindOf(Buffer.from(String(f.data || '').split(',').pop(), 'base64')))) throw bad('Only photos (no other files)');
    const t = await createTicket(tn, { service_id: svc.id, name: str(b.name, 80), email: b.email, phone: b.phone, requestor_type: b.requestor_type || 'student',
      identifier: str(b.identifier, 60) || null, department: str(b.department, 80) || null,
      subject: `${foodCategory(b.category)} · ${MEAL_NAMES[meal]}${loc ? ' · ' + loc.name : ''}`, description, location: loc?.name || 'Food service',
      form_data: { food_category: b.category, food_category_label: foodCategory(b.category), meal, food_location: loc?.name || '' },
      files, idempotency_key: b.idempotency_key, merge: b.merge }, { channel: 'portal', actor: { type: 'requestor', name: str(b.name, 80) }, food: true });
    await run('UPDATE tickets SET food_location_id=?, meal=?, food_category=? WHERE id=? AND meal IS NULL', loc?.id || null, meal, b.category, t.id);
    return { ticket_no: t.ticket_no, tracking_token: t.tracking_token, due_at: t.due_at, merged: !!t.merged, affected_count: t.affected_count || 1 };
  }));

  // ---------- staff: kitchen dashboard (food providers and admins) ----------
  const foodAccess = async req => {
    const svc = await foodService(req.tenantId); if (!svc) throw new HttpErr(404, 'NOT_FOUND', 'No food service on this campus yet. Set a service’s form type to Food.');
    if (req.user.role === 'provider' && !(await one(`SELECT 1 AS x FROM service_members m JOIN services s ON s.id=m.service_id
      WHERE m.user_id=? AND s.tenant_id=? AND s.form_schema::jsonb->>'form_type'='food'`, req.user.id, req.tenantId))) throw new HttpErr(403, 'FORBIDDEN', 'Only the food team and admins see food scores');
    return svc;
  };
  const range = (req, tn) => {
    const today = dayIn(tzOf(tn), now()), q = req.query;
    const to = YMD.test(q.to || '') ? q.to : today, from = YMD.test(q.from || '') ? q.from : today;
    if (from > to) throw bad('From must be on or before To');
    return { from, to, today };
  };
  S.get('/food/access', wrap(async req => { try { const s = await foodAccess(req); return { ok: true, service: { id: s.id, name: s.name } }; } catch { return { ok: false }; } }));
  S.get('/food/dashboard', wrap(async req => {
    const svc = await foodAccess(req), tn = await tenantRow(req.tenantId), { from, to, today } = range(req, tn), loc = req.query.location || null;
    return { service: { id: svc.id, name: svc.name }, today: summarize(await feedbackIn(tn.id, today, today, loc), today, today),
      period: summarize(await feedbackIn(tn.id, from, to, loc), from, to),
      locations: await all('SELECT id, name, active FROM food_locations WHERE tenant_id=? ORDER BY sort_order, name', tn.id),
      complaints: (await one(`SELECT count(*)::int n FROM tickets WHERE service_id=? AND status IN ('open','in_progress','hold')`, svc.id)).n };
  }));
  S.get('/food/feedback.csv', async (req, res, next) => { try {
    await foodAccess(req); const tn = await tenantRow(req.tenantId), { from, to } = range(req, tn);
    const rows = await feedbackIn(tn.id, from, to, req.query.location || null), cols = ['meal_date', 'meal', 'location', 'rating', 'chips', 'comment', 'requester_name', 'converted_from_complaint', 'created_at'];
    const cell = v => `"${String(Array.isArray(v) ? v.join('; ') : v ?? '').replace(/"/g, '""')}"`;
    res.type('text/csv').attachment(`food-feedback-${from}-to-${to}.csv`).send([cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n'));
  } catch (e) { next(e); } });
  // admin: messes / canteens and meal times
  S.get('/food/settings', wrap(async req => ({ windows: await mealWindows(req.tenantId),
    locations: await all('SELECT id, name, active, sort_order FROM food_locations WHERE tenant_id=? ORDER BY sort_order, name', req.tenantId) })));
  S.put('/food/settings', wrap(async req => {
    if (req.user.role === 'provider') throw new HttpErr(403, 'FORBIDDEN', 'Only admins change food settings');
    const b = req.body || {};
    if (b.windows) for (const m of MEALS) { const w = b.windows[m]; if (!w) continue;
      if (!HM.test(w[0] || '') || !HM.test(w[1] || '') || w[0] >= w[1]) throw bad(`${MEAL_NAMES[m]}: times as HH:MM, start before end`); }
    if (b.locations && !Array.isArray(b.locations)) throw bad('Locations must be a list');
    const names = (b.locations || []).map(l => str(l.name, 80)); if (names.some(n => !n)) throw bad('Every location needs a name');
    if (new Set(names.map(n => n.toLowerCase())).size !== names.length) throw bad('Two locations have the same name');
    if (b.windows) for (const m of MEALS) if (b.windows[m]) await run(`INSERT INTO meal_windows (id, tenant_id, meal, start_time, end_time) VALUES (?,?,?,?,?)
      ON CONFLICT (tenant_id, meal) DO UPDATE SET start_time=excluded.start_time, end_time=excluded.end_time`, uid(), req.tenantId, m, b.windows[m][0], b.windows[m][1]);
    if (b.locations) for (const [i, l] of b.locations.entries()) {
      if (l.id && await one('SELECT 1 AS x FROM food_locations WHERE id=? AND tenant_id=?', l.id, req.tenantId))
        await run('UPDATE food_locations SET name=?, active=?, sort_order=? WHERE id=?', names[i], l.active === false || l.active === 0 ? 0 : 1, i, l.id);
      else await insert('food_locations', { id: uid(), tenant_id: req.tenantId, name: names[i], active: l.active === false ? 0 : 1, sort_order: i });
    }
    return { ok: true };
  }));

  // ---------- scheduled reports (feedback only) ----------
  // Charts are PNG images (Outlook shows no scripts or SVG), fetched by the mail app from a signed link.
  const signChart = spec => { const p = Buffer.from(JSON.stringify(spec)).toString('base64url');
    return `${p}.${crypto.createHmac('sha256', SECRET).update('chart:' + p).digest('base64url').slice(0, 22)}`; };
  app.get('/api/food-chart/:token.png', (req, res) => {
    const [p, s] = String(req.params.token).split('.');
    if (!p || !s || crypto.createHmac('sha256', SECRET).update('chart:' + p).digest('base64url').slice(0, 22) !== s) return res.status(404).end();
    let spec; try { spec = JSON.parse(Buffer.from(p, 'base64url')); } catch { return res.status(404).end(); }
    res.set('Cache-Control', 'public, max-age=31536000, immutable').type('png').send(chartPng(spec));
  });
  const chartImg = (spec, alt) => `<img src="${base()}/api/food-chart/${signChart(spec)}.png" width="520" alt="${esc(alt)}" style="display:block;width:100%;max-width:520px;height:auto;border:1px solid #eceef5;border-radius:10px;margin:6px 0">`;
  const legend = meals => `<p style="margin:2px 0 14px;font-size:12px;color:#5b5f73">${meals.map(m => `<span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${MEAL_COLORS[m]};margin:0 4px 0 10px"></span>${MEAL_NAMES[m]}`).join('')}</p>`;
  const h2 = t => `<p style="margin:22px 0 8px;font-size:12px;font-weight:700;letter-spacing:.6px;color:#8b8fa8;text-transform:uppercase">${t}</p>`;
  const stars = v => v == null ? '—' : `${v.toFixed(1)} ★`;
  const fmtDay = ymd => new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const mealTable = s => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eceef5;border-radius:12px;border-collapse:separate">
    ${MEALS.map((m, i) => `<tr><td style="padding:9px 14px;${i ? 'border-top:1px solid #f0f1f6;' : ''}"><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${MEAL_COLORS[m]};margin-right:8px"></span><b>${MEAL_NAMES[m]}</b></td>
      <td style="padding:9px 14px;font-size:16px;font-weight:700;${i ? 'border-top:1px solid #f0f1f6;' : ''}">${stars(s.per_meal[m].avg)}</td>
      <td style="padding:9px 14px;color:#8b8fa8;font-size:13px;${i ? 'border-top:1px solid #f0f1f6;' : ''}">${s.per_meal[m].count} rating${s.per_meal[m].count === 1 ? '' : 's'}${s.per_meal[m].chips.length ? ' · ' + esc(s.per_meal[m].chips.map(c => c.chip).join(', ')) : ''}</td></tr>`).join('')}</table>`;
  const issues = (list, n) => list.length ? `<ol style="margin:0;padding-left:20px;font-size:14px;line-height:1.7">${list.slice(0, n).map(c => `<li>${esc(c.chip)} <span style="color:#8b8fa8">(${c.count})</span></li>`).join('')}</ol>` : '<p style="color:#8b8fa8;font-size:14px">No issues tagged.</p>';
  const comments = (list, n) => list.length ? list.slice(0, n).map(c => `<p style="margin:0 0 8px;padding:10px 12px;background:#f6f7fb;border-radius:10px;font-size:14px;line-height:1.5">“${esc(c.comment)}”
    <br><span style="color:#8b8fa8;font-size:12px">${MEAL_NAMES[c.meal]}${c.rating ? ` · ${c.rating} ★` : ''}${c.location ? ` · ${esc(c.location)}` : ''}${c.converted ? ' · sent as feedback instead of a complaint' : ''}</span></p>`).join('') : '<p style="color:#8b8fa8;font-size:14px">No comments.</p>';
  const arrow = (a, b) => a == null || b == null ? '' : a > b ? ` <span style="color:#1a9a56">▲ ${(a - b).toFixed(1)}</span>` : a < b ? ` <span style="color:#e5484d">▼ ${(b - a).toFixed(1)}</span>` : ' <span style="color:#8b8fa8">= same</span>';

  // The report for one campus and period: { subject, html, text, to, empty }
  async function buildReport(tn, period, refDay) {
    const today = refDay || dayIn(tzOf(tn), now()), svc = await foodService(tn.id);
    const [from, to] = period === 'daily' ? [today, today] : period === 'weekly' ? [addDays(today, -6), today] : [today.slice(0, 8) + '01', today];
    const s = summarize(await feedbackIn(tn.id, from, to), from, to), title = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }[period];
    const span = from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`, link = `${base()}/#/c/food?from=${from}&to=${to}`;
    const subject = `[Food] ${title} feedback report · ${tn.name} · ${span}`, to_ = svc ? (await providersFor(tn.id, svc.id)).map(p => p.email) : [];
    let body;
    if (!s.total) body = `<p style="font-size:15px;line-height:1.55">No feedback received for ${esc(span)}.</p><p style="font-size:14px;color:#5b5f73">Ask students to tap <b>Food → Rate your meal</b> after each meal; it takes 10 seconds.</p>`;
    else if (period === 'daily') body = `<p style="font-size:15px">Today: <b>${stars(s.avg)}</b> from ${s.rated} rating${s.rated === 1 ? '' : 's'}${s.total > s.rated ? ` (+${s.total - s.rated} converted complaint${s.total - s.rated === 1 ? '' : 's'})` : ''}.</p>
      ${h2('Score per meal')}${mealTable(s)}
      ${h2('Number of ratings per meal')}${chartImg({ type: 'bar', labels: MEALS, colors: MEALS.map(m => MEAL_COLORS[m]), series: [{ color: '#1e4b8f', values: MEALS.map(m => s.per_meal[m].count) }] }, 'Number of ratings per meal')}
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin-bottom:14px"><tr>${MEALS.map(m => `<td align="center" width="25%" style="font-size:12px;color:#5b5f73"><b style="color:${MEAL_COLORS[m]}">${MEAL_NAMES[m]}</b><br>${s.per_meal[m].count} · ${stars(s.per_meal[m].avg)}</td>`).join('')}</tr></table>
      ${h2('Top 3 issues')}${issues(s.chips.filter(c => !c.chip.startsWith('Good')), 3)}${h2('Comments')}${comments(s.comments, 15)}`;
    else if (period === 'weekly') {
      const ranked = MEALS.filter(m => s.per_meal[m].avg != null).sort((a, b) => s.per_meal[b].avg - s.per_meal[a].avg);
      body = `<p style="font-size:15px">This week: <b>${stars(s.avg)}</b> from ${s.rated} ratings.${ranked.length ? ` Best: <b>${MEAL_NAMES[ranked[0]]}</b> (${stars(s.per_meal[ranked[0]].avg)}). Needs work: <b>${MEAL_NAMES[ranked.at(-1)]}</b> (${stars(s.per_meal[ranked.at(-1)].avg)}).` : ''}</p>
      ${h2('Daily score per meal')}${chartImg({ type: 'line', labels: s.days, max: 5, series: MEALS.map(m => ({ color: MEAL_COLORS[m], values: s.series[m] })) }, 'Daily score per meal')}
      <p style="margin:0;font-size:12px;color:#8b8fa8">${fmtDay(from)} → ${fmtDay(to)} · scale 0 to 5 ★</p>${legend(MEALS)}
      ${h2('Score per meal')}${mealTable(s)}${h2('Recurring issues')}${issues(s.chips.filter(c => !c.chip.startsWith('Good')), 5)}${h2('Comments')}${comments(s.comments, 10)}`;
    } else {
      const prev = addDays(from, -1), pf = prev.slice(0, 8) + '01', p = summarize(await feedbackIn(tn.id, pf, prev), pf, prev);
      const weeks = []; for (let w = from; w <= to; w = addDays(w, 7)) weeks.push([w, addDays(w, 6) > to ? to : addDays(w, 6)]);
      const wk = m => weeks.map(([a, b]) => avg(s.days.filter(d => d >= a && d <= b).map((d, _, __) => s.series[m][s.days.indexOf(d)]).filter(v => v != null)));
      const moved = MEALS.filter(m => s.per_meal[m].avg != null && p.per_meal[m].avg != null).map(m => [m, s.per_meal[m].avg - p.per_meal[m].avg]);
      body = `<p style="font-size:15px">This month: <b>${stars(s.avg)}</b> from ${s.rated} ratings. Last month: ${stars(p.avg)}${arrow(s.avg, p.avg)}.</p>
      ${h2('Weekly trend per meal')}${chartImg({ type: 'line', labels: weeks.map(w => w[0]), max: 5, series: MEALS.map(m => ({ color: MEAL_COLORS[m], values: wk(m) })) }, 'Weekly trend per meal')}
      <p style="margin:0;font-size:12px;color:#8b8fa8">Week by week, ${fmtDay(from)} → ${fmtDay(to)} · scale 0 to 5 ★</p>${legend(MEALS)}
      ${h2('This month vs last month')}<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eceef5;border-radius:12px">${MEALS.map((m, i) =>
        `<tr><td style="padding:9px 14px;${i ? 'border-top:1px solid #f0f1f6;' : ''}"><b>${MEAL_NAMES[m]}</b></td><td style="padding:9px 14px;${i ? 'border-top:1px solid #f0f1f6;' : ''}">${stars(s.per_meal[m].avg)}${arrow(s.per_meal[m].avg, p.per_meal[m].avg)}</td><td style="padding:9px 14px;color:#8b8fa8;font-size:13px;${i ? 'border-top:1px solid #f0f1f6;' : ''}">last month ${stars(p.per_meal[m].avg)}</td></tr>`).join('')}</table>
      ${moved.length ? `<p style="font-size:14px">Improved: <b>${moved.filter(x => x[1] > 0).map(x => MEAL_NAMES[x[0]]).join(', ') || 'none'}</b> · Declined: <b>${moved.filter(x => x[1] < 0).map(x => MEAL_NAMES[x[0]]).join(', ') || 'none'}</b></p>` : ''}
      ${h2('Most repeated issues')}${issues(s.chips.filter(c => !c.chip.startsWith('Good')), 5)}`;
    }
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#f3f4fb;font-family:'Segoe UI',Arial,sans-serif;color:#1c1d2e">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4fb;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:580px;background:#ffffff;border-radius:16px;border:1px solid #eceef5">
<tr><td style="background:#1e4b8f;padding:18px 24px;color:#ffffff;font-size:16px;font-weight:700;border-bottom:4px solid #f29a1f">ONE Desk<span style="font-weight:400;opacity:.85"> · ${esc(tn.name)}</span></td></tr>
<tr><td style="padding:24px 24px 10px"><div style="font:700 12px Consolas,monospace;color:#8b8fa8;letter-spacing:.5px">${title.toUpperCase()} FOOD FEEDBACK · ${esc(span.toUpperCase())}</div>
<h1 style="font-size:20px;margin:6px 0 12px">${esc(svc?.name || 'Food service')}</h1>${body}
<p style="margin:22px 0 8px"><a href="${esc(link)}" style="display:inline-block;background:#1e4b8f;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px">View full report</a></p></td></tr>
<tr><td style="padding:14px 24px;background:#fafbfe;color:#8b8fa8;font-size:12px">Feedback only (no tickets). Complaints arrive as tickets in your ONE Desk queue.</td></tr>
</table></td></tr></table></body></html>`;
    const text = `${subject}\n\n${s.total ? `Average ${stars(s.avg)} from ${s.rated} ratings.\n${MEALS.map(m => `${MEAL_NAMES[m]}: ${stars(s.per_meal[m].avg)} (${s.per_meal[m].count})`).join('\n')}\nTop issues: ${s.chips.slice(0, 3).map(c => c.chip).join(', ') || 'none'}` : `No feedback received for ${span}.`}\n\nView full report: ${link}`;
    return { tenant: tn.slug, period, from, until: to, subject, html, text, to: to_, empty: !s.total, summary: s }; // to: who it is mailed to
  }
  // GET /api/reports/food/daily|weekly|monthly?tenant=<slug>[&date=YYYY-MM-DD][&format=json], with the report key
  // (header X-Report-Key or ?key=). Power Automate fetches this and mails `html` to `to`.
  const reportKey = () => process.env.FOOD_REPORT_KEY || getSettings().food_report_key || '';
  app.get('/api/reports/food/:period', wrap(async (req, res) => {
    const key = reportKey(); if (!key) throw new HttpErr(503, 'NOT_CONFIGURED', 'Set FOOD_REPORT_KEY on the server first');
    const sent = String(req.get('x-report-key') || req.query.key || '');
    if (sent.length !== key.length || !crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(key))) throw new HttpErr(401, 'UNAUTHORIZED', 'Wrong report key');
    if (!['daily', 'weekly', 'monthly'].includes(req.params.period)) throw notFound();
    const tn = await tenantBySlug(String(req.query.tenant || ''));
    const r = await buildReport(tn, req.params.period, YMD.test(req.query.date || '') ? req.query.date : null);
    if (req.query.format === 'json') { const { summary, ...rest } = r; return rest; }
    res.type('html').send(r.html);
  }));
  // ONE Desk also sends them itself at 10:00 PM campus time (daily; weekly on Sunday; monthly on the month's last day),
  // unless FOOD_REPORT_AUTOSEND=0 (when Power Automate sends them instead).
  async function sendDue() {
    if (process.env.FOOD_REPORT_AUTOSEND === '0') return;
    for (const tn of await all('SELECT * FROM tenants WHERE is_active=1')) {
      const tz = tzOf(tn), hm = localHM(tz); if (hm < '22:00' || hm > '22:30') continue;
      const day = dayIn(tz, now()), dow = new Date(day + 'T12:00:00Z').getUTCDay(), last = addDays(day, 1).slice(8) === '01';
      for (const period of ['daily', ...(dow === 0 ? ['weekly'] : []), ...(last ? ['monthly'] : [])]) {
        const k = `food_report:${tn.id}:${period}`; if (getSettings()[k] === day) continue;
        await d.setSetting(k, day);
        const r = await buildReport(tn, period, day); if (r.to.length) await sendMail(tn.id, r.to, `food_${period}`, r.subject, r.html, r.text);
      }
    }
  }
  setInterval(() => sendDue().catch(e => console.error('food report', e.message)), 60e3).unref?.();
  return { buildReport };
}
