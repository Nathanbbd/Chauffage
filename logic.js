// Logique partagée entre l'app (mode démo) et le Worker (vraie régulation).
// Une seule source de vérité : si tu changes une règle ici, les deux suivent.

export const PROFILES = [
  { id: 'maison',   name: 'À la maison' },
  { id: 'nuit',     name: 'Nuit' },
  { id: 'absent',   name: 'Absent' },
  { id: 'vacances', name: 'Vacances' },
];

// Valeur par pièce : un nombre = consigne en °C, 'horsgel' = chauffage coupé.
export const DEFAULT_SCHEDULE = {
  hyst: 1,
  profiles: {
    maison:   { chambre: 19, salon: 20 },
    nuit:     { chambre: 18, salon: 17 },
    absent:   { chambre: 16, salon: 16 },
    vacances: { chambre: 'horsgel', salon: 'horsgel' },
  },
  planning: {
    semaine: [ { h: '06:30', p: 'maison' }, { h: '08:30', p: 'absent' }, { h: '18:00', p: 'maison' }, { h: '23:00', p: 'nuit' } ],
    weekend: [ { h: '08:30', p: 'maison' }, { h: '23:30', p: 'nuit' } ],
  },
};

const toMin = h => { const [a, b] = h.split(':').map(Number); return a * 60 + b; };

// Décalage Paris/UTC en ms (gère l'heure d'été), un seul appel Intl.
export function parisOffset(ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ts)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour, +p.minute) - Math.floor(ts / 60e3) * 60e3;
}

// Tous les créneaux du planning, d'hier à J+7, en timestamps absolus.
function slots(sched, ts) {
  const off = parisOffset(ts);
  const mid = Math.floor((ts + off) / 864e5) * 864e5;
  const out = [];
  for (let k = -1; k < 8; k++) {
    const m = mid + k * 864e5, d = new Date(m).getUTCDay();
    const list = [...(sched.planning?.[d === 0 || d === 6 ? 'weekend' : 'semaine'] || [])]
      .sort((a, b) => toMin(a.h) - toMin(b.h));
    for (const s of list) out.push({ t: m + toMin(s.h) * 60e3 - off, p: s.p });
  }
  return out;
}
const nextDifferent = (all, ts, p) => all.find(s => s.t > ts && s.p !== p) ?? null;

export function planAt(sched, ts) {
  const all = slots(sched, ts);
  let cur = null;
  for (const s of all) if (s.t <= ts) cur = s;
  const profile = cur?.p ?? 'maison';
  return { profile, next: nextDifferent(all, ts, profile) };
}

// Boutons rapides et Raccourcis iPhone → forçage de présence.
export function presenceFor(action, sched, now, until) {
  const all = slots(sched, now);
  if (action === 'home') return { profile: 'maison', until: nextDifferent(all, now, 'maison')?.t ?? null };
  if (action === 'away') return { profile: 'absent', until: nextDifferent(all, now, 'absent')?.t ?? null };
  if (action === 'vacation') return { profile: 'vacances', until: until ?? null };
  return null; // 'planning' : on retire le forçage
}

// Ce que la pièce doit viser maintenant.
export function target(room, sched, presence, now) {
  const forced = presence && (presence.until == null || presence.until > now) ? presence : null;
  let profile, until, source;
  if (forced) { profile = forced.profile; until = forced.until; source = 'manuel'; }
  else { const pl = planAt(sched, now); profile = pl.profile; until = pl.next?.t ?? null; source = 'planning'; }
  const v = sched.profiles?.[profile]?.[room.id];
  let sp = typeof v === 'number' ? v : null;
  const manual = room.manualSp != null && room.manualUntil > now;
  if (manual) sp = room.manualSp;
  return { profile, until, source, sp, manual };
}

// Décision pour le module fil pilote : 'on' (Confort), 'eco' ou 'off' (Hors-gel).
// Relance quand temp ≤ consigne − écart, coupe dès que la consigne est atteinte.
export function decide(room, sp, hyst = 1) {
  if (room.mode === 'confort') return 'on';
  if (room.mode === 'eco') return 'eco';
  if (room.mode === 'horsgel') return 'off';
  if (sp == null) return 'off';
  if (room.temp == null) return room.heating ? 'on' : 'off';
  if (room.heating) return room.temp < sp ? 'on' : 'off';
  return room.temp <= sp - hyst ? 'on' : 'off';
}
