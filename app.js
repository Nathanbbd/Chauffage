import { PROFILES, DEFAULT_SCHEDULE, target, decide, presenceFor } from './shared/logic.js';

/* =========================================================
   CONFIG
   ========================================================= */
const ROOMS = [{ id: 'chambre', name: 'Chambre' }, { id: 'salon', name: 'Salon' }];
const MODES = [
  { id: 'auto',    label: 'Auto',     hint: 'Suit le profil actif (planning ou présence) et régule avec le thermomètre.' },
  { id: 'confort', label: 'Confort',  hint: 'Le radiateur suit son propre bouton (7/8). L’app ne régule plus.' },
  { id: 'eco',     label: 'Eco',      hint: 'Consigne du bouton moins 3 à 4 °C.' },
  { id: 'horsgel', label: 'Hors-gel', hint: 'Chauffage coupé, le radiateur ne protège que du gel.' },
];
const PLANS = [{ id: 'semaine', name: 'Du lundi au vendredi' }, { id: 'weekend', name: 'Samedi et dimanche' }];
const DIAL_MIN = 14, DIAL_MAX = 26, SP_MIN = 15, SP_MAX = 25;
const DEFAULTS = { demo: true, workerUrl: '', token: '', price: 0.20, power: { chambre: 1000, salon: 1500 } };

const store = {
  load() { try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('chauffage') || '{}') }; } catch { return { ...DEFAULTS }; } },
  save(c) { try { localStorage.setItem('chauffage', JSON.stringify(c)); } catch {} },
};
let cfg = store.load();

/* =========================================================
   API (contrat du Worker, voir worker/src/index.js)
   ========================================================= */
async function req(path, opts = {}) {
  const r = await fetch(cfg.workerUrl.replace(/\/$/, '') + path, {
    ...opts, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.token },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Le Worker a répondu ' + r.status);
  return j;
}
const post = (path, body, method = 'POST') => req(path, { method, body: JSON.stringify(body) });
const api = {
  rooms:          ()            => cfg.demo ? mock.rooms()                 : req('/rooms'),
  set:            (id, patch)   => cfg.demo ? mock.set(id, patch)          : post('/rooms/' + id, patch),
  history:        ()            => cfg.demo ? mock.history()               : req('/history?hours=24'),
  events:         ()            => cfg.demo ? mock.events()                : req('/events?limit=40'),
  schedule:       ()            => cfg.demo ? mock.schedule()              : req('/schedule'),
  saveSchedule:   s             => cfg.demo ? mock.saveSchedule(s)         : post('/schedule', s, 'PUT'),
  presence:       ()            => cfg.demo ? mock.presence()              : req('/presence'),
  presenceAction: (action, until) => cfg.demo ? mock.presenceAction(action, until) : post('/presence', { action, until }),
};

/* =========================================================
   MOCK : même logique que le Worker (shared/logic.js)
   ========================================================= */
const mock = (() => {
  const STEP = 5 * 60e3, start = Date.now(), state = {}, hist = {}, evts = [];
  let sched = structuredClone(DEFAULT_SCHEDULE), presence = null;
  ROOMS.forEach((r, i) => {
    const room = { id: r.id, mode: 'auto', temp: 17.4 + i * 0.6, heating: false, manualSp: null, manualUntil: null };
    hist[r.id] = [];
    for (let k = 287; k >= 0; k--) {
      const t = start - k * STEP, tg = target(room, sched, null, t);
      const heating = decide(room, tg.sp, sched.hyst) === 'on';
      if (heating !== room.heating) evts.push({ t, room: r.id, type: heating ? 'on' : 'off', temp: room.temp, reason: tg.profile });
      room.heating = heating;
      room.temp += (heating ? 0.11 : -0.03) + (Math.random() - 0.5) * 0.02;
      hist[r.id].push({ t, temp: Math.round(room.temp), sp: tg.sp, heating }); // capteur au degré près
    }
    room.updated = start;
    state[r.id] = room;
  });
  function tick() {
    const t = Date.now();
    ROOMS.forEach(r => {
      const room = state[r.id];
      if (room.manualUntil && room.manualUntil <= t) room.manualSp = room.manualUntil = null;
      const tg = target(room, sched, presence, t);
      const heating = decide(room, tg.sp, sched.hyst) === 'on';
      if (heating !== room.heating) evts.push({ t, room: r.id, type: heating ? 'on' : 'off', temp: room.temp, reason: room.mode === 'auto' ? tg.profile : room.mode });
      room.heating = heating;
      room.temp += (heating ? 0.04 : -0.012) + (Math.random() - 0.5) * 0.01;
      room.updated = t;
    });
  }
  setInterval(tick, 3000);
  const view = room => {
    const tg = target(room, sched, presence, Date.now());
    return { id: room.id, temp: room.temp, setpoint: tg.sp, mode: room.mode, heating: room.heating, updated: room.updated,
      profile: tg.profile, source: tg.source, until: tg.until, manual: tg.manual, manualUntil: room.manualUntil };
  };
  const presenceView = () => { const tg = target({ id: '_' }, sched, presence, Date.now()); return { profile: tg.profile, source: tg.source, until: tg.until }; };
  return {
    rooms: async () => ROOMS.map(r => view(state[r.id])),
    set: async (id, p) => {
      const room = state[id], t = Date.now();
      if (p.mode && p.mode !== room.mode) {
        room.mode = p.mode;
        if (p.mode === 'auto') room.manualSp = room.manualUntil = null;
        evts.push({ t, room: id, type: 'mode', temp: room.temp, reason: p.mode });
      }
      if (typeof p.setpoint === 'number') {
        const base = target({ ...room, manualSp: null }, sched, presence, t);
        room.manualSp = p.setpoint; room.manualUntil = base.until ?? t + 12 * 36e5;
        evts.push({ t, room: id, type: 'setpoint', temp: p.setpoint, reason: 'manuel' });
      }
      tick(); return view(room);
    },
    history: async () => structuredClone(hist),
    events: async () => structuredClone(evts.slice(-40).reverse()),
    schedule: async () => structuredClone(sched),
    saveSchedule: async s => { sched = structuredClone(s); tick(); return structuredClone(sched); },
    presence: async () => presenceView(),
    presenceAction: async (action, until) => { presence = presenceFor(action, sched, Date.now(), until); tick(); return presenceView(); },
  };
})();

/* =========================================================
   UTILS
   ========================================================= */
const $ = s => document.querySelector(s);
const fmt = (n, d = 1) => Number(n).toFixed(d).replace('.', ',');
const hhmm = t => new Date(t).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const roomName = id => ROOMS.find(r => r.id === id)?.name ?? id;
const profName = id => PROFILES.find(p => p.id === id)?.name ?? id;
const spText = v => (typeof v === 'number' ? `${fmt(v)} °C` : 'Hors-gel');
function untilText(t, source) {
  if (t == null) return source === 'manuel' ? 'jusqu’à nouvel ordre' : '';
  const d = new Date(t), today = new Date();
  if (d.toDateString() === today.toDateString()) return `jusqu’à ${hhmm(t)}`;
  return `jusqu’au ${d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' })} à ${hhmm(t)}`;
}

/* =========================================================
   STATE
   ========================================================= */
let rooms = {}, current = 'chambre', tab = 'thermo', dragging = false, pendingSp = null;
let draft = null, pres = null;

/* --- Sélecteur de pièce --- */
function renderRooms() {
  $('#rooms').innerHTML = ROOMS.map(r =>
    `<button data-room="${r.id}" aria-pressed="${r.id === current}"><span class="dot ${rooms[r.id]?.heating ? 'on' : ''}"></span>${r.name}</button>`).join('');
}
$('#rooms').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  current = b.dataset.room; renderAll();
});

/* =========================================================
   THERMOSTAT
   ========================================================= */
const C = 140, R = 116;
const angleOf = v => 135 + (clamp(v, DIAL_MIN, DIAL_MAX) - DIAL_MIN) / (DIAL_MAX - DIAL_MIN) * 270;
const pt = a => [C + R * Math.cos(a * Math.PI / 180), C + R * Math.sin(a * Math.PI / 180)];
function arc(a1, a2) {
  if (a2 - a1 < 0.5) a2 = a1 + 0.5;
  const [x1, y1] = pt(a1), [x2, y2] = pt(a2);
  return `M${x1} ${y1} A${R} ${R} 0 ${a2 - a1 > 180 ? 1 : 0} 1 ${x2} ${y2}`;
}
function renderDial() {
  const s = rooms[current]; if (!s) return;
  const sp = pendingSp ?? s.setpoint;
  const color = s.heating ? 'var(--heat)' : (sp == null || s.mode === 'horsgel' ? 'var(--cool)' : 'var(--idle)');
  const ticks = [];
  for (let v = DIAL_MIN; v <= DIAL_MAX; v++) {
    const a = angleOf(v) * Math.PI / 180, r1 = R + 14, r2 = v % 2 ? R + 17 : R + 20;
    ticks.push(`<line x1="${C + r1 * Math.cos(a)}" y1="${C + r1 * Math.sin(a)}" x2="${C + r2 * Math.cos(a)}" y2="${C + r2 * Math.sin(a)}" stroke="var(--line)" stroke-width="2" stroke-linecap="round"/>`);
  }
  const knob = typeof sp === 'number' ? (() => { const [kx, ky] = pt(angleOf(sp));
    return `<circle class="knob" cx="${kx}" cy="${ky}" r="15" fill="var(--surface)" stroke="var(--ink)" stroke-width="3"/>`; })() : '';
  const temp = s.temp ?? DIAL_MIN;
  $('#dialSvg').innerHTML = `
    ${ticks.join('')}
    <path d="${arc(135, 405)}" fill="none" stroke="var(--line)" stroke-width="14" stroke-linecap="round"/>
    <path class="arc" d="${arc(135, angleOf(temp))}" fill="none" stroke="${color}" stroke-width="14" stroke-linecap="round"/>
    ${knob}
    <text x="${pt(135)[0] - 2}" y="${pt(135)[1] + 30}" font-size="12" fill="var(--muted)" text-anchor="middle">${DIAL_MIN}°</text>
    <text x="${pt(405)[0] + 2}" y="${pt(405)[1] + 30}" font-size="12" fill="var(--muted)" text-anchor="middle">${DIAL_MAX}°</text>`;
  $('#now').innerHTML = s.temp == null ? '–' : `${fmt(s.temp)}<sup>°</sup>`;
  $('#sp').textContent = spText(sp);

  const st = $('#status');
  st.className = 'status' + (s.heating ? ' on' : '');
  st.textContent = {
    auto: s.heating ? `Chauffe pour atteindre ${spText(sp)}` : sp == null ? 'Chauffage coupé par le profil' : 'Consigne tenue, radiateur au repos',
    confort: 'Confort forcé, le bouton du radiateur décide',
    eco: 'Eco forcé',
    horsgel: 'Chauffage coupé',
  }[s.mode];

  const pl = $('#profline');
  if (s.mode !== 'auto') pl.innerHTML = '';
  else if (s.manual) pl.innerHTML = `Consigne manuelle ${untilText(s.manualUntil)}<button class="linkbtn" id="backProfile">Revenir au profil</button>`;
  else pl.textContent = `${profName(s.profile)} ${untilText(s.until, s.source)}`.trim();

  $('#minus').disabled = $('#plus').disabled = s.mode !== 'auto';
  $('#dial').style.opacity = s.mode === 'auto' ? 1 : .55;
}
$('#profline').addEventListener('click', async e => {
  if (e.target.id !== 'backProfile') return;
  try { rooms[current] = await api.set(current, { mode: 'auto' }); } catch (err) { showConn(err); }
  renderAll();
});

function setpointFromPointer(e) {
  const box = $('#dialSvg').getBoundingClientRect();
  const x = (e.clientX - box.left) / box.width * 280, y = (e.clientY - box.top) / box.height * 280;
  let rel = ((Math.atan2(y - C, x - C) * 180 / Math.PI) - 135 + 720) % 360;
  if (rel > 270) rel = rel > 315 ? 0 : 270;
  const v = DIAL_MIN + rel / 270 * (DIAL_MAX - DIAL_MIN);
  return clamp(Math.round(v * 2) / 2, SP_MIN, SP_MAX);
}
const dialEl = $('#dial');
dialEl.addEventListener('pointerdown', e => {
  if (rooms[current]?.mode !== 'auto') return;
  dragging = true; dialEl.setPointerCapture(e.pointerId);
  pendingSp = setpointFromPointer(e); renderDial();
});
dialEl.addEventListener('pointermove', e => { if (!dragging) return; pendingSp = setpointFromPointer(e); renderDial(); });
dialEl.addEventListener('pointerup', () => { if (!dragging) return; dragging = false; commitSetpoint(pendingSp); });

let spTimer;
function nudge(d) {
  const s = rooms[current]; if (!s || s.mode !== 'auto') return;
  pendingSp = clamp((pendingSp ?? s.setpoint ?? 19) + d, SP_MIN, SP_MAX); renderDial();
  clearTimeout(spTimer); spTimer = setTimeout(() => commitSetpoint(pendingSp), 700);
}
$('#minus').onclick = () => nudge(-0.5);
$('#plus').onclick = () => nudge(0.5);
async function commitSetpoint(v) {
  try { rooms[current] = await api.set(current, { setpoint: v }); } catch (err) { showConn(err); }
  pendingSp = null; renderAll();
}

function renderModes() {
  const s = rooms[current]; if (!s) return;
  $('#modes').innerHTML = MODES.map(m => `<button data-mode="${m.id}" aria-pressed="${s.mode === m.id}">${m.label}</button>`).join('');
  $('#modeHint').textContent = MODES.find(m => m.id === s.mode).hint;
}
$('#modes').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  try { rooms[current] = await api.set(current, { mode: b.dataset.mode }); } catch (err) { showConn(err); }
  renderAll();
});

/* =========================================================
   PRÉSENCE
   ========================================================= */
async function loadPresence(withSchedule) {
  try {
    if (withSchedule) draft = await api.schedule();
    pres = await api.presence();
  } catch (err) { showConn(err); return; }
  renderPresence(withSchedule);
}
function renderPresence(full) {
  if (!pres) return;
  $('#pName').textContent = profName(pres.profile);
  $('#pWhy').textContent = (pres.source === 'manuel' ? 'Forcé ' : 'Selon le planning ') + untilText(pres.until, pres.source);
  const activeAct = pres.source === 'planning' ? 'planning'
    : { maison: 'home', absent: 'away', vacances: 'vacation' }[pres.profile];
  document.querySelectorAll('#quick button').forEach(b => b.setAttribute('aria-pressed', b.dataset.act === activeAct));
  if (full) { renderProfiles(); renderPlanning(); $('#hyst').value = draft.hyst ?? 1; }
}
$('#quick').addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.act === 'vacation') {
    $('#vacBox').hidden = !$('#vacBox').hidden;
    if (!$('#vacDate').value) $('#vacDate').value = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    return;
  }
  $('#vacBox').hidden = true;
  try { pres = await api.presenceAction(b.dataset.act); } catch (err) { showConn(err); }
  renderPresence(false); refresh();
});
$('#vacOk').onclick = async () => {
  const d = $('#vacDate').value; if (!d) return;
  // Retour le jour J à 00:00 : le planning reprend la veille au soir pour un appart chaud à l'arrivée
  const until = new Date(d + 'T00:00').getTime();
  try { pres = await api.presenceAction('vacation', until); } catch (err) { showConn(err); }
  $('#vacBox').hidden = true; renderPresence(false); refresh();
};

function renderProfiles() {
  $('#profiles').innerHTML = PROFILES.map(p => `
    <div class="block"><h3>${p.name}</h3>
      ${ROOMS.map(r => `<div class="prow"><span>${r.name}</span><div class="step">
        <button type="button" data-p="${p.id}" data-r="${r.id}" data-d="-0.5" aria-label="Baisser ${p.name} ${r.name}">−</button>
        <b>${spText(draft.profiles[p.id]?.[r.id])}</b>
        <button type="button" data-p="${p.id}" data-r="${r.id}" data-d="0.5" aria-label="Monter ${p.name} ${r.name}">+</button>
      </div></div>`).join('')}
    </div>`).join('');
}
$('#profiles').addEventListener('click', e => {
  const b = e.target.closest('button[data-p]'); if (!b) return;
  const { p, r } = b.dataset, d = Number(b.dataset.d);
  draft.profiles[p] ??= {};
  const v = draft.profiles[p][r];
  draft.profiles[p][r] = typeof v !== 'number'
    ? (d > 0 ? SP_MIN : 'horsgel')
    : (v + d < SP_MIN ? 'horsgel' : clamp(v + d, SP_MIN, SP_MAX));
  renderProfiles();
});

function renderPlanning() {
  $('#planning').innerHTML = PLANS.map(pl => `
    <div class="block"><h3>${pl.name}</h3>
      ${(draft.planning[pl.id] || []).map((s, i) => `<div class="slot">
        <input type="time" value="${s.h}" data-pl="${pl.id}" data-i="${i}" data-f="h" aria-label="Heure">
        <select data-pl="${pl.id}" data-i="${i}" data-f="p" aria-label="Profil">
          ${PROFILES.map(p => `<option value="${p.id}" ${p.id === s.p ? 'selected' : ''}>${p.name}</option>`).join('')}
        </select>
        <button type="button" class="x" data-del="${pl.id}" data-i="${i}" aria-label="Supprimer ce créneau">×</button>
      </div>`).join('')}
      <button type="button" class="add" data-add="${pl.id}">Ajouter un créneau</button>
    </div>`).join('');
}
$('#planning').addEventListener('change', e => {
  const { pl, i, f } = e.target.dataset; if (!pl) return;
  draft.planning[pl][i][f] = e.target.value;
});
$('#planning').addEventListener('click', e => {
  const del = e.target.closest('[data-del]'), add = e.target.closest('[data-add]');
  if (del) draft.planning[del.dataset.del].splice(Number(del.dataset.i), 1);
  else if (add) (draft.planning[add.dataset.add] ??= []).push({ h: '12:00', p: 'maison' });
  else return;
  renderPlanning();
});
$('#schedForm').addEventListener('submit', async e => {
  e.preventDefault();
  draft.hyst = Number($('#hyst').value) || 1;
  for (const k of Object.keys(draft.planning)) draft.planning[k] = draft.planning[k].filter(s => s.h).sort((a, b) => a.h.localeCompare(b.h));
  try { draft = await api.saveSchedule(draft); $('#schedMsg').textContent = 'Planning enregistré.'; }
  catch (err) { $('#schedMsg').textContent = `Échec : ${err.message}`; return; }
  await loadPresence(true); refresh();
});

/* =========================================================
   INFOS
   ========================================================= */
async function renderInfos() {
  let hist, evts;
  try { [hist, evts] = await Promise.all([api.history(), api.events()]); } catch (err) { showConn(err); return; }
  const step = pts => pts.length > 1 ? (pts[pts.length - 1].t - pts[0].t) / (pts.length - 1) / 36e5 : 5 / 60;
  const cost = id => {
    const pts = hist[id] || [];
    const hours = pts.filter(p => p.heating).length * step(pts);
    const kwh = hours * (cfg.power[id] || 0) / 1000;
    return { hours, kwh, eur: kwh * cfg.price };
  };
  const c = cost(current);
  $('#stTime').textContent = `${Math.floor(c.hours)} h ${String(Math.round(c.hours % 1 * 60)).padStart(2, '0')}`;
  $('#stKwh').textContent = `${fmt(c.kwh)} kWh`;
  $('#stCost').textContent = `${fmt(c.eur, 2)} €`;
  const all = ROOMS.reduce((s, r) => s + cost(r.id).eur, 0);
  $('#stTotal').textContent = `Les deux pièces : ${fmt(all, 2)} € sur 24 h, soit environ ${Math.round(all * 30)} € par mois à ce rythme.`;

  const pts = (hist[current] || []).filter(p => p.temp != null);
  const W = 600, H = 220, L = 34, B = 24, T = 10;
  if (pts.length < 2) { $('#chart').innerHTML = `<text x="300" y="110" text-anchor="middle" font-size="14" fill="var(--muted)">Pas encore assez de relevés</text>`; }
  else {
    const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
    const vals = pts.flatMap(p => [p.temp, p.sp]).filter(v => typeof v === 'number');
    const lo = Math.floor(Math.min(...vals) - .5), hi = Math.ceil(Math.max(...vals) + .5);
    const X = t => L + (t - t0) / (t1 - t0 || 1) * (W - L - 6);
    const Y = v => T + (hi - v) / (hi - lo) * (H - T - B);
    let svg = '', startT = null;
    pts.forEach((p, i) => {
      if (p.heating && startT === null) startT = p.t;
      if ((!p.heating || i === pts.length - 1) && startT !== null) {
        svg += `<rect x="${X(startT)}" y="${T}" width="${Math.max(1, X(p.t) - X(startT))}" height="${H - T - B}" fill="var(--heat-soft)"/>`;
        startT = null;
      }
    });
    for (let v = lo; v <= hi; v++) {
      svg += `<line x1="${L}" x2="${W}" y1="${Y(v)}" y2="${Y(v)}" stroke="var(--line)" stroke-width="1"/>`;
      svg += `<text x="${L - 6}" y="${Y(v) + 4}" font-size="11" fill="var(--muted)" text-anchor="end">${v}°</text>`;
    }
    for (let t = Math.ceil(t0 / 216e5) * 216e5; t <= t1; t += 216e5) {
      svg += `<text x="${X(t)}" y="${H - 6}" font-size="11" fill="var(--muted)" text-anchor="middle">${hhmm(t).slice(0, 2)} h</text>`;
    }
    // Consigne : coupée là où le profil est en hors-gel
    let d = '', pen = false;
    for (const p of pts) {
      if (typeof p.sp !== 'number') { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${X(p.t)} ${Y(p.sp)} `; pen = true;
    }
    svg += `<path d="${d}" fill="none" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4 4"/>`;
    // Lissage pour l'affichage uniquement (moyenne glissante ~1 h)
    const SMOOTH = 6;
    const smooth = pts.map((p, i) => {
      const win = pts.slice(Math.max(0, i - SMOOTH), i + SMOOTH + 1);
      return { t: p.t, temp: win.reduce((s, q) => s + q.temp, 0) / win.length };
    });
    svg += `<polyline fill="none" stroke="var(--ink)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" points="${smooth.map(p => `${X(p.t)},${Y(p.temp)}`).join(' ')}"/>`;
    $('#chart').innerHTML = svg;
  }

  const label = e => ({
    on: 'Chauffe lancée', off: 'Chauffe coupée',
    mode: `Mode ${MODES.find(m => m.id === e.reason)?.label ?? e.reason}`,
    setpoint: 'Consigne modifiée',
  }[e.type]);
  const list = evts.filter(e => e.room === current);
  $('#log').innerHTML = list.length
    ? list.map(e => `<li><time>${hhmm(e.t)}</time><span>${label(e)}</span><span class="t">${e.temp == null ? '' : fmt(e.temp) + ' °C'}</span></li>`).join('')
    : `<li class="empty">Aucun déclenchement pour ${roomName(current)} sur la période.</li>`;
}

/* =========================================================
   RÉGLAGES
   ========================================================= */
function fillForm() {
  const f = $('#form');
  f.p_chambre.value = cfg.power.chambre; f.p_salon.value = cfg.power.salon; f.price.value = cfg.price;
  f.workerUrl.value = cfg.workerUrl; f.token.value = cfg.token; f.demo.checked = cfg.demo;
}
function readForm() {
  const f = $('#form');
  return {
    power: { chambre: +f.p_chambre.value || 0, salon: +f.p_salon.value || 0 },
    price: +f.price.value || 0, workerUrl: f.workerUrl.value.trim(), token: f.token.value, demo: f.demo.checked,
  };
}
$('#form').addEventListener('submit', e => {
  e.preventDefault();
  const wasDemo = cfg.demo;
  cfg = readForm(); store.save(cfg);
  $('#msg').textContent = 'Réglages enregistrés.';
  if (wasDemo !== cfg.demo) location.reload(); else refresh();
});
$('#test').onclick = async () => {
  const prev = cfg; cfg = { ...readForm(), demo: false };
  $('#msg').textContent = 'Connexion au Worker…';
  try { const r = await api.rooms(); $('#msg').textContent = `Connecté, ${r.length} pièce(s) trouvée(s).`; }
  catch (err) { $('#msg').textContent = cfg.workerUrl ? `Échec : ${err.message}. Vérifie l’adresse et le code d’accès.` : 'Renseigne l’adresse du Worker.'; }
  cfg = prev;
};

/* =========================================================
   NAVIGATION + BOUCLE
   ========================================================= */
document.querySelectorAll('nav button').forEach(b => b.onclick = () => {
  tab = b.dataset.tab;
  document.querySelectorAll('nav button').forEach(x => x === b ? x.setAttribute('aria-current', 'page') : x.removeAttribute('aria-current'));
  ['thermo', 'presence', 'infos', 'reglages'].forEach(t => $('#tab-' + t).hidden = t !== tab);
  $('#rooms').hidden = tab === 'reglages' || tab === 'presence';
  if (tab === 'infos') renderInfos();
  if (tab === 'presence') { $('#schedMsg').textContent = ''; loadPresence(true); }
  if (tab === 'reglages') fillForm();
});

function showConn(err) {
  const p = $('#conn');
  if (cfg.demo) { p.textContent = 'Mode démo'; p.className = 'pill'; return; }
  if (err) { p.textContent = 'Worker injoignable'; p.className = 'pill warn'; return; }
  const last = Math.max(0, ...Object.values(rooms).map(r => r.updated || 0));
  const min = Math.round((Date.now() - last) / 60e3);
  p.textContent = min < 1 ? 'À jour' : `Relevé il y a ${min} min`;
  p.className = 'pill' + (min > 15 ? ' warn' : '');
}

function renderAll() { renderRooms(); renderDial(); renderModes(); if (tab === 'infos') renderInfos(); }
async function refresh() {
  try {
    rooms = Object.fromEntries((await api.rooms()).map(r => [r.id, r]));
    showConn();
  } catch (err) { showConn(err); }
  if (!dragging && pendingSp === null) renderAll();
  if (tab === 'presence') loadPresence(false);
}
refresh();
setInterval(refresh, cfg.demo ? 3000 : 30000);
