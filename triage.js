(function (root) {
  'use strict';

  const WEIGHTS = { medical: 25, maternal: 25, mobility: 20, age: 10, hazard: 12, distance: 8 };
  const WAIT_MAX_BONUS = 10;
  const WAIT_CAP_MIN = 120;
  const UNVERIFIED_FLOOR = 40;
  const DISTANCE_CAP_KM = 12;
  const BAND_CRITICAL = 60;
  const BAND_HIGH = 35;

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  const MEDICAL_SEVERITY = { oxygen: 1, dialysis: 1, highRiskPregnancy: 1, insulin: 0.7, other: 0.5 };
  const MOBILITY = { independent: 0, assisted: 0.5, wheelchair: 0.85, bedridden: 1 };

  function medicalFactor(list) {
    if (!list || !list.length) return 0;
    const sev = list.map(m => MEDICAL_SEVERITY[m] ?? 0.5);
    return clamp(Math.max(...sev) + 0.15 * (list.length - 1), 0, 1);
  }

  function maternalFactor(w) {
    let f = 0;
    if (w.pregnancyWeeks != null) {
      const wk = w.pregnancyWeeks;
      f = wk >= 36 ? 1 : wk >= 28 ? 0.75 : wk >= 20 ? 0.4 : 0.2;
    }
    if (w.postpartumWeeks != null && w.postpartumWeeks <= 6) f = Math.max(f, 0.9);
    if (w.infants > 0) f = Math.max(f, w.infants > 1 ? 0.8 : 0.6);
    return f;
  }

  function ageFactor(age) {
    return age == null ? 0 : clamp((age - 55) / 25, 0, 1);
  }

  function nearestOpenShelterKm(w, shelters) {
    const open = shelters.filter(s => s.open);
    if (!open.length) return DISTANCE_CAP_KM;
    return Math.min(...open.map(s => dist(w.pos, s.pos)));
  }

  function scoreWoman(w, ctx) {
    const hazard = clamp(ctx.hazardByWard?.[w.ward] ?? 0, 0, 1);
    const blocked = (ctx.blockedWards || []).includes(w.ward);
    const km = nearestOpenShelterKm(w, ctx.shelters || []);
    const distFactor = blocked ? 1 : clamp(km / DISTANCE_CAP_KM, 0, 1);
    const waitMin = w.requestedAt ? Math.max(0, ((ctx.now ?? Date.now()) - w.requestedAt) / 60000) : 0;

    const factors = [
      { key: 'medical', label: 'Medical dependency', v: medicalFactor(w.medical),
        why: (w.medical && w.medical.length) ? w.medical.join(', ') : 'none reported' },
      { key: 'maternal', label: 'Maternal / infant', v: maternalFactor(w),
        why: [w.pregnancyWeeks != null ? `${w.pregnancyWeeks} wks pregnant` : '',
              w.postpartumWeeks != null && w.postpartumWeeks <= 6 ? `${w.postpartumWeeks} wks postpartum` : '',
              w.infants > 0 ? `${w.infants} infant(s)` : ''].filter(Boolean).join(', ') || 'n/a' },
      { key: 'mobility', label: 'Mobility', v: MOBILITY[w.mobility] ?? 0, why: w.mobility || 'unknown' },
      { key: 'age', label: 'Age', v: ageFactor(w.age), why: w.age != null ? `${w.age} yrs` : 'unknown' },
      { key: 'hazard', label: 'Flood hazard (ward)', v: hazard, why: `${w.ward} level ${hazard.toFixed(2)}` },
      { key: 'distance', label: 'Distance to shelter', v: distFactor,
        why: blocked ? 'road blocked' : `${km.toFixed(1)} km` }
    ].map(f => ({ ...f, weight: WEIGHTS[f.key], points: +(f.v * WEIGHTS[f.key]).toFixed(1) }));

    const waitPoints = +(clamp(waitMin, 0, WAIT_CAP_MIN) / WAIT_CAP_MIN * WAIT_MAX_BONUS).toFixed(1);
    let score = factors.reduce((s, f) => s + f.points, 0) + waitPoints;
    let floorApplied = false;
    if (w.unverified && score < UNVERIFIED_FLOOR) { score = UNVERIFIED_FLOOR; floorApplied = true; }
    score = +clamp(score, 0, 100).toFixed(1);

    // stretcher cases in badly flooded wards are always critical; clinical flags keep someone at high or above
    const fv = (k) => factors.find(f => f.key === k).v;
    const flags = [];
    if (fv('maternal') >= 0.75) flags.push('late pregnancy / newborn');
    if (fv('medical') >= 0.7) flags.push('serious medical need');
    if (fv('mobility') >= 0.85) flags.push('cannot walk');
    if (w.age != null && w.age >= 75) flags.push('age 75+');
    let band = score >= BAND_CRITICAL ? 'critical' : score >= BAND_HIGH ? 'high' : 'standard';
    if (needsStretcher(w) && hazard >= 0.6) band = 'critical';
    else if (flags.length && band === 'standard') band = 'high';

    return { score, factors, waitPoints, waitMin: Math.round(waitMin), floorApplied, band, flags };
  }

  const BAND_ORDER = { critical: 3, high: 2, standard: 1 };
  // sort by band, then score, then waiting time, then id
  function rankQueue(people, ctx) {
    return people
      .map(p => ({ person: p, result: scoreWoman(p, ctx) }))
      .sort((a, b) =>
        BAND_ORDER[b.result.band] - BAND_ORDER[a.result.band] ||
        b.result.score - a.result.score ||
        (a.person.requestedAt || 0) - (b.person.requestedAt || 0) ||
        String(a.person.id).localeCompare(String(b.person.id)));
  }

  const SHELTER_WEIGHTS = { security: 30, water: 25, medical: 25, sanitation: 20 };

  function shelterStatus(s, now) {
    const hours = (now - s.lastUpdated) / 3600000;
    const stale = hours >= 8;
    const penalty = +Math.min(10, hours).toFixed(1);
    const base = Object.keys(SHELTER_WEIGHTS)
      .reduce((sum, k) => sum + clamp(s[k], 0, 1) * SHELTER_WEIGHTS[k], 0);
    return { base: +base.toFixed(1), penalty, rank: +Math.max(0, base - penalty).toFixed(1), hours: +hours.toFixed(1), stale };
  }

  const PAR_RATIO = { menstrual: 0.25, formula: 0.08, prenatal: 0.06 };   // assumed ratios
  function supplyLevels(s) {
    return Object.keys(PAR_RATIO).map(k => {
      const par = Math.max(1, Math.ceil(s.capacity * PAR_RATIO[k]));
      const have = s.stock[k] ?? 0;
      const pct = have / par;
      return { key: k, have, par, pct, level: pct < 0.2 ? 'critical' : pct < 0.5 ? 'low' : 'ok' };
    });
  }

  function needsStretcher(w) {
    return w.mobility === 'bedridden' || (w.medical || []).some(m => m === 'oxygen' || m === 'dialysis');
  }
  function seatsNeeded(w) {
    return 1 + (w.infants || 0) + (w.mobility === 'bedridden' || w.mobility === 'wheelchair' ? 1 : 0);
  }

  function planDispatch(ranked, vehicles, shelters, now) {
    const remaining = new Map(vehicles.map(v => [v.id, v.seats]));
    const room = new Map(shelters.map(s => [s.id, s.capacity - s.occupied]));
    const assignments = [];
    const unassigned = [];
    const openShelters = shelters.filter(s => s.open);
    const ambSeats = () => vehicles.filter(v => v.type === 'ambulance').reduce((n, v) => n + remaining.get(v.id), 0);

    ranked.forEach((row, idx) => {
      const w = row.person;
      const need = seatsNeeded(w);
      const stretcher = needsStretcher(w);
      // keep ambulance seats free for stretcher cases further down the list
      const reserve = stretcher ? 0 : ranked.slice(idx + 1)
        .filter(r => needsStretcher(r.person)).reduce((n, r) => n + seatsNeeded(r.person), 0);
      const candidates = vehicles
        .filter(v => remaining.get(v.id) >= need)
        .filter(v => stretcher ? v.type === 'ambulance' : (v.type !== 'ambulance' || ambSeats() - need >= reserve))
        .sort((a, b) => dist(a.pos, w.pos) - dist(b.pos, w.pos));
      const v = candidates[0];
      if (!v) {
        unassigned.push({ person: w, reason: stretcher ? 'no ambulance with free seats'
          : vehicles.some(x => remaining.get(x.id) >= need) ? 'ambulance seats held for stretcher cases' : 'no vehicle with free seats' });
        return;
      }

      // shelter: has room for her and her infants; clinical cases need a shelter with medical cover
      const people = 1 + (w.infants || 0);
      const clinical = medicalFactor(w.medical) >= 0.7 || w.pregnancyWeeks >= 36;
      const fits = openShelters.filter(s => room.get(s.id) >= people);
      const capable = clinical ? fits.filter(s => s.medical >= 0.5) : fits;
      const pool = capable.length ? capable : fits;
      const dest = pool
        .map(s => ({ s, st: shelterStatus(s, now) }))
        .sort((a, b) => (b.st.rank - 2.5 * dist(b.s.pos, w.pos)) - (a.st.rank - 2.5 * dist(a.s.pos, w.pos)))[0];
      let warning = null;
      if (!dest) warning = 'no open shelter has room, coordinator must choose';
      else if (clinical && !capable.length) warning = 'no shelter with medical cover has room';
      remaining.set(v.id, remaining.get(v.id) - need);
      if (dest) room.set(dest.s.id, room.get(dest.s.id) - people);
      assignments.push({ person: w, vehicle: v, shelter: dest ? dest.s : null, score: row.result.score, band: row.result.band, warning });
    });
    return { assignments, unassigned, seatsLeft: Object.fromEntries(remaining) };
  }

  // format: HELP <ward> [P<weeks>] [O] [M] [B] [X]
  function parseHelpSms(text, validWards) {
    const t = String(text || '').trim().toUpperCase().split(/\s+/);
    if (t[0] !== 'HELP') return { ok: false, error: 'Message must start with HELP' };
    const ward = t[1];
    if (!ward || !validWards.includes(ward)) return { ok: false, error: 'Unknown ward code' };
    const out = { ok: true, ward, pregnancyWeeks: null, age: null, mobility: 'independent', infants: 0, medical: [] };
    for (const tok of t.slice(2)) {
      let m;
      if ((m = /^P(\d{1,2})$/.exec(tok))) {
        const wk = parseInt(m[1], 10);
        if (wk >= 1 && wk <= 42) out.pregnancyWeeks = wk; else return { ok: false, error: 'Pregnancy weeks must be 1 to 42' };
      } else if (tok === 'O') out.age = 70;
      else if (tok === 'M') out.mobility = 'assisted';
      else if (tok === 'B') out.infants = 1;
      else if (tok === 'X') out.medical = ['other'];
      else return { ok: false, error: `Unrecognised code ${tok}` };
    }
    return out;
  }

  const api = { WEIGHTS, WAIT_MAX_BONUS, UNVERIFIED_FLOOR, BAND_CRITICAL, BAND_HIGH, SHELTER_WEIGHTS, PAR_RATIO, dist,
    medicalFactor, maternalFactor, ageFactor, scoreWoman, rankQueue,
    shelterStatus, supplyLevels, needsStretcher, seatsNeeded, planDispatch, parseHelpSms };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Triage = api;
})(typeof window !== 'undefined' ? window : globalThis);
