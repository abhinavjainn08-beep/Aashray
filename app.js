// front end for the prototype. state lives in localStorage, SMS and sync are simulated
(function () {
  'use strict';
  const T = window.Triage, D = window.AashrayData;
  const KEY = 'aashray-state-v1';

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const wardOf = (c) => D.WARDS.find(w => w.code === c);
  const wardName = (c) => (wardOf(c) || {}).name || c;
  const KIT = { menstrual: 'Menstrual hygiene kits', formula: 'Infant formula', prenatal: 'Prenatal kits' };
  const HAZARD_LEVELS = [[0, 'None'], [0.3, 'Low'], [0.6, 'High'], [0.9, 'Severe']];
  const TABS = {
    dispatch: [['dispatch', 'Dispatch'], ['registry', 'Care list'], ['shelters', 'Shelters & supplies'], ['phone', 'Phone / SMS']],
    health: [['registry', 'Care list'], ['phone', 'Phone / SMS']],
    volunteer: [['shelters', 'Shelters & supplies'], ['phone', 'Phone / SMS']]
  };

  function fresh() {
    const now = Date.now();
    return {
      v: 1, rev: 0, registry: D.seedRegistry(), shelters: D.seedShelters(now), vehicles: D.seedVehicles(),
      alert: null, requests: [], dispatched: [], smsLog: [], thread: [], audit: [], outbox: [],
      offline: false, seq: { q: 1, r: 15, sms: 1 }
    };
  }
  function load() {
    try { const raw = localStorage.getItem(KEY); const s = raw && JSON.parse(raw); return s && s.v === 1 ? s : null; }
    catch (e) { return null; }
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* storage unavailable: run in memory */ } }

  let state = load() || fresh();
  const ui = { role: 'dispatch', tab: 'dispatch', expanded: new Set(), plan: null, myShelter: 'S1', ward: 'ALL', lastMissed: null };

  const isOffline = () => state.offline;
  // rev changes whenever a dispatch plan could be affected, so an old preview gets re-checked
  function commit(opts) { if (!(opts && opts.keepRev)) state.rev++; save(); renderAll(); }
  function audit(action) {
    state.audit.unshift({ ts: Date.now(), role: ui.role, action });
    if (state.audit.length > 200) state.audit.length = 200;
  }
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
  }
  function queueIfOffline(label) { if (isOffline()) state.outbox.push({ kind: 'update', label }); }

  function sendSms(to, text, kind) {
    const queued = isOffline();
    state.smsLog.unshift({ id: state.seq.sms++, ts: Date.now(), to, kind, text, status: queued ? 'queued' : 'sent' });
    if (queued) state.outbox.push({ kind: 'sms', label: `SMS to ${to}` });
  }

  function alertCtx() {
    return { hazardByWard: state.alert ? state.alert.hazard : {}, blockedWards: state.alert ? state.alert.blocked : [], shelters: state.shelters, now: Date.now() };
  }
  function rankInputs() {
    const done = new Set(state.dispatched.map(d => d.id));
    const reg = state.alert ? state.registry.filter(p => !done.has(p.id)).map(p => ({ ...p, requestedAt: state.alert.raisedAt })) : [];
    const req = state.requests.filter(p => !done.has(p.id) && !p.dismissed);
    return [...reg, ...req];
  }
  function ranked() {
    const rows = T.rankQueue(rankInputs(), alertCtx());
    rows.sort((a, b) => (b.person.pinned ? 1 : 0) - (a.person.pinned ? 1 : 0));
    return rows;
  }
  const eligible = (p) => !p.unverified || p.callbackDone;

  function makePlan() {
    const rows = ranked();
    const ok = rows.filter(r => eligible(r.person));
    const vehicles = state.vehicles.map(v => ({ ...v, seats: v.seatsFree }));
    const plan = T.planDispatch(ok, vehicles, state.shelters, Date.now());
    plan.waitingCallback = rows.filter(r => !eligible(r.person)).map(r => r.person);
    plan.rev = state.rev;
    return plan;
  }

  const MED_LABEL = { oxygen: 'oxygen', dialysis: 'dialysis', insulin: 'insulin', highRiskPregnancy: 'high-risk pregnancy', other: 'other medical need' };
  const MOB_LABEL = { assisted: 'needs help walking', wheelchair: 'wheelchair', bedridden: 'bedridden' };
  function describeNeed(p) {
    const bits = [];
    if (p.pregnancyWeeks != null) bits.push(`${p.pregnancyWeeks} wks pregnant`);
    if (p.postpartumWeeks != null && p.postpartumWeeks <= 6) bits.push('newborn');
    if (p.infants > 0) bits.push(`${p.infants} infant${p.infants > 1 ? 's' : ''}`);
    if (p.mobility && MOB_LABEL[p.mobility]) bits.push(MOB_LABEL[p.mobility]);
    if (p.medical && p.medical.length) bits.push(p.medical.map(m => MED_LABEL[m] || m).join(', '));
    if (p.age != null && p.age >= 75) bits.push(`age ${p.age}`);
    return bits.join(', ') || 'no special need listed';
  }

  function confirmPlan() {
    if (!ui.plan) return;
    if (ui.plan.rev !== state.rev) {
      ui.plan = makePlan();
      toast('Situation changed since the preview. Plan refreshed, please review it again.');
      return renderAll();
    }
    const n = ui.plan.assignments.length;
    const byVehicle = {};
    for (const a of ui.plan.assignments) {
      const v = state.vehicles.find(x => x.id === a.vehicle.id);
      const p = a.person;
      const seats = T.seatsNeeded(p);
      v.seatsFree -= seats;
      state.dispatched.push({ id: p.id, initials: p.initials, ward: p.ward, vehicleId: v.id, shelterId: a.shelter ? a.shelter.id : null, seats, score: a.score, band: a.band, at: Date.now(), delivered: false });
      const dest = a.shelter ? a.shelter.name : 'nearest open shelter';
      const where = p.addressNote ? `Address: ${p.addressNote}.` : 'Address: confirm on callback.';
      (byVehicle[v.id] = byVehicle[v.id] || { v, lines: [] }).lines.push(`${p.initials}, ${wardName(p.ward)} (${describeNeed(p)}). ${where}${p.phone ? ' Phone ' + p.phone + '.' : ''} Drop at ${dest}.`);
      if (p.phone) {
        sendSms(p.phone, `Aashray: ${v.label} is coming to take you to ${dest}. Keep medicines and documents ready.\nआश्रय: आपको ${dest} ले जाने के लिए वाहन (${v.label}) आ रहा है। दवाइयाँ और ज़रूरी कागज़ साथ रखें।`, 'woman');
      }
      audit(`Dispatched ${p.initials} (${wardName(p.ward)}, ${a.band}, score ${a.score}) in ${v.label} to ${dest}`);
    }
    for (const { v, lines } of Object.values(byVehicle)) {
      sendSms(`${v.driver} (${v.label})`, `Aashray: ${lines.length} pickup${lines.length === 1 ? '' : 's'}, in this order:\n${lines.map((l, i) => `${i + 1}) ${l}`).join('\n')}\nReply DONE <number> after each drop.`, 'driver');
    }
    ui.plan = null;
    toast(`${n} pickup${n === 1 ? '' : 's'} dispatched. ${isOffline() ? 'SMS queued until you are back online.' : 'SMS sent (simulated).'}`);
    commit();
  }

  function newRequest(f, source, phone) {
    const w = wardOf(f.ward);
    return {
      id: 'Q' + (state.seq.q++), initials: 'Caller', ward: f.ward, pos: { ...w.pos }, age: f.age ?? null,
      pregnancyWeeks: f.pregnancyWeeks ?? null, postpartumWeeks: null, infants: f.infants || 0,
      mobility: f.mobility || 'independent', medical: f.medical || [], unverified: true, source, phone,
      requestedAt: Date.now(), callbackDone: false, detailsUnknown: source === 'missedcall'
    };
  }
  function deliverRequest(req) {
    // while offline the request is held at the gateway and reaches the queue after sync
    if (isOffline()) state.outbox.push({ kind: 'incoming', label: `Request ${req.id} held at gateway`, payload: req });
    else state.requests.push(req);
  }
  const SIM_PHONE = '98765 43210';
  function handleSms(text) {
    state.thread.push({ dir: 'out', text });
    const r = T.parseHelpSms(text, D.WARDS.map(w => w.code));
    if (!r.ok) {
      state.thread.push({ dir: 'in', text: `Aashray: could not read your message (${r.error}).\nSend: HELP <ward> [P<weeks>] [O] [M] [B] [X]\nExample: HELP W3 P34 M` });
    } else {
      const req = newRequest(r, 'sms', SIM_PHONE);
      deliverRequest(req);
      state.thread.push({ dir: 'in', text: `Aashray: request received for ward ${r.ward} (${wardName(r.ward)}). A coordinator will call you back. Ref ${req.id}.\nआश्रय: आपका अनुरोध मिल गया है। समन्वयक आपको वापस कॉल करेंगे। संदर्भ ${req.id}।` });
    }
    commit();
  }
  function handleMissedCall(ward) {
    const req = newRequest({ ward }, 'missedcall', SIM_PHONE);
    deliverRequest(req);
    ui.lastMissed = { id: req.id, ward };
    state.thread.push({ dir: 'out', text: `(missed call to the helpline from ${SIM_PHONE})` });
    state.thread.push({ dir: 'in', text: 'IVR callback (simulated):\n"Press 1 if you need transport. Press 2 for the nearest shelter."\n"परिवहन के लिए 1 दबाएँ। नज़दीकी आश्रय के लिए 2 दबाएँ।"' });
    commit();
  }
  function pressKey(k) {
    if (!ui.lastMissed) return;
    const { id, ward } = ui.lastMissed;
    state.thread.push({ dir: 'out', text: `(pressed ${k})` });
    if (k === 1) {
      const req = state.requests.find(r => r.id === id) || (state.outbox.find(o => o.payload && o.payload.id === id) || {}).payload;
      if (req) req.pressed1 = true;
      state.thread.push({ dir: 'in', text: `Aashray: transport request noted, ref ${id}. Stay where you are, a coordinator will call.\nआश्रय: परिवहन अनुरोध दर्ज हुआ, संदर्भ ${id}।` });
    } else {
      const open = state.shelters.filter(s => s.open).map(s => ({ s, d: T.dist(s.pos, wardOf(ward).pos) })).sort((a, b) => a.d - b.d)[0];
      state.thread.push({ dir: 'in', text: open ? `Aashray: nearest open shelter to ${wardName(ward)} is ${open.s.name} (about ${open.d.toFixed(1)} km).\nआश्रय: नज़दीकी आश्रय: ${open.s.name}।` : 'Aashray: no open shelter on record. A coordinator will call you.' });
    }
    commit();
  }

  function raiseAlert() {
    const sc = D.SCENARIO_RIVER_BREACH;
    state.alert = { name: sc.name, hazard: { ...sc.hazard }, blocked: [...sc.blocked], raisedAt: Date.now() };
    ui.justRaised = true;
    audit(`Alert raised: ${sc.name}`);
    audit(`Care list unlocked for dispatch (${state.registry.length} records)`);
    queueIfOffline('Alert raised');
    commit();
  }
  function standDown() {
    state.alert = null; ui.plan = null;
    audit('Alert stood down; care list locked again');
    queueIfOffline('Alert stood down');
    commit();
  }

  function setOffline(v) {
    if (state.offline === v) return;
    state.offline = v;
    if (v) audit('Went offline: working from the local copy');
    else flushOutbox();
    commit({ keepRev: v });
  }
  function flushOutbox() {
    const n = state.outbox.length;
    state.smsLog.forEach(m => { if (m.status === 'queued') m.status = 'sent'; });
    state.outbox.filter(o => o.kind === 'incoming').forEach(o => state.requests.push(o.payload));
    state.outbox = [];
    audit(`Back online: synced ${n} pending item${n === 1 ? '' : 's'}`);
    if (n) toast(`Back online: ${n} pending item${n === 1 ? '' : 's'} synced.`);
  }

  function renderAll() {
    const tabs = TABS[ui.role];
    if (!tabs.some(t => t[0] === ui.tab)) ui.tab = tabs[0][0];
    $('#role').value = ui.role;
    $('#offline').checked = state.offline;
    const net = $('#netchip');
    net.textContent = state.offline ? 'Offline' : 'Online';
    net.className = 'chip ' + (state.offline ? 'off' : 'ok');
    const ob = $('#outbox');
    ob.hidden = !state.outbox.length;
    ob.className = 'chip sync';
    ob.textContent = `${state.outbox.length} pending sync`;

    const bar = $('#alertbar');
    const parts = [];
    if (state.alert) parts.push(`Alert active: ${state.alert.name}`);
    if (state.offline) parts.push('Offline: this screen keeps working from the local copy. SMS and gateway messages wait until the connection returns.');
    bar.hidden = !parts.length;
    bar.className = 'alertbar' + (state.alert ? '' : ' calm');
    bar.textContent = parts.join('  |  ');

    $('#tabs').innerHTML = tabs.map(([id, label]) =>
      `<button role="tab" data-act="tab" data-tab="${id}" aria-selected="${id === ui.tab}">${label}</button>`).join('');
    for (const id of ['dispatch', 'registry', 'shelters', 'phone']) $('#tab-' + id).hidden = id !== ui.tab;
    renderPanel();
    if (ui.refocus) { const t = $(ui.refocus); if (t) t.focus({ preventScroll: true }); ui.refocus = null; }
  }
  function renderPanel() {
    ({ dispatch: renderDispatch, registry: renderRegistry, shelters: renderShelters, phone: renderPhone })[ui.tab]();
  }

  const bandChip = (b) => `<span class="chip ${b}">${b}</span>`;

  const LEVEL_NAME = (v) => (HAZARD_LEVELS.find(l => l[0] === v) || HAZARD_LEVELS[0])[1];

  // gauge: water height is the flood hazard level
  function gaugeSVG(code, lvl, i) {
    const x = 10, y = 4, w = 24, h = 104;
    const wy = (l) => y + h * (1 - l);
    let ticks = '';
    for (let k = 1; k < 10; k++) {
      const ty = y + h - (h * k) / 10;
      ticks += `<line class="staff-tick" x1="${x}" x2="${x + (k % 3 === 0 ? 10 : 6)}" y1="${ty}" y2="${ty}"/>`;
    }
    return `<svg viewBox="0 0 44 112" width="44" height="112" aria-hidden="true">
      <defs><clipPath id="gc-${code}"><rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/></clipPath></defs>
      <g clip-path="url(#gc-${code})">
        <rect class="staff-bed" x="${x}" y="${y}" width="${w}" height="${h}"/>
        <g class="water" style="--lvl:${lvl};--i:${i}"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#3f84b8" opacity=".92"/><rect x="${x}" y="${y}" width="${w}" height="3" fill="#a6d2ee"/></g>
        ${ticks}
      </g>
      <rect class="staff-frame" x="${x}" y="${y}" width="${w}" height="${h}" rx="3"/>
      <line x1="5" x2="39" y1="${wy(0.3)}" y2="${wy(0.3)}" stroke="#e8a317" stroke-width="1.5" stroke-dasharray="3 2"/>
      <line x1="5" x2="39" y1="${wy(0.6)}" y2="${wy(0.6)}" stroke="#f26a3d" stroke-width="1.5" stroke-dasharray="3 2"/>
    </svg>`;
  }

  function wardSummary(rows) {
    const byWard = {}, rk = { critical: 3, high: 2, standard: 1 };
    rows.forEach(r => {
      const w = byWard[r.person.ward] || (byWard[r.person.ward] = { n: 0, best: 'standard' });
      w.n++;
      if (rk[r.result.band] > rk[w.best]) w.best = r.result.band;
    });
    return byWard;
  }

  function renderDispatch() {
    const el = $('#tab-dispatch');
    const a = state.alert;
    const rows = ranked();
    const counts = { critical: 0, high: 0, standard: 0 };
    rows.forEach(r => counts[r.result.band]++);
    const active = state.dispatched.filter(d => !d.delivered);
    const byWard = wardSummary(rows);
    const seats = state.vehicles.reduce((n, v) => n + v.seatsFree, 0);

    let html = '';
    if (!a) {
      html += `<div class="card hero"><div class="empty-hero"><h2>No active alert</h2>
        <button class="btn danger" data-act="raise">Raise alert: sample river breach</button></div>
        <p class="muted" style="margin-top:10px">The care list stays locked until an alert is raised. Raising one unlocks it for dispatch and is written to the audit log. Help requests that arrive by SMS or missed call are still ranked below.</p></div>`;
    } else {
      html += `<div class="card hero"><div class="row"><h2>${esc(a.name)}</h2><span class="spacer"></span>
        <span class="muted">Raised ${fmtTime(a.raisedAt)}</span><button class="btn light small" data-act="standdown">Stand down</button></div>
        <div class="gauges${ui.justRaised ? ' rise' : ''}">
        ${D.WARDS.map((w, i) => {
          const lvl = a.hazard[w.code] ?? 0, info = byWard[w.code], blocked = a.blocked.includes(w.code);
          return `<div class="gauge-item">
            <button class="gauge-btn" data-act="cyclehazard" data-ward="${w.code}" aria-label="${esc(w.code + ' ' + w.name)}, flood hazard ${LEVEL_NAME(lvl)}. Activate to change the level.">
              ${gaugeSVG(w.code, lvl, i)}
              <span class="gauge-info"><b>${w.code}</b><span class="name">${esc(w.name)}</span><span class="level">${LEVEL_NAME(lvl)}</span>
              <span class="waiting ${info ? info.best : ''}">${info ? info.n + ' waiting' : 'none waiting'}</span></span>
            </button>
            <button class="road${blocked ? ' blocked' : ''}" data-act="toggleroad" data-ward="${w.code}" aria-pressed="${blocked}">${blocked ? 'road blocked' : 'road open'}</button>
          </div>`;
        }).join('')}
        </div>
        <p class="gauge-help muted"><i style="color:var(--high)"></i>Low hazard mark <i style="color:var(--crit)"></i>High hazard mark. The coordinator sets each ward's level: select a gauge to change it.</p></div>`;
      ui.justRaised = false;
    }

    html += `<div class="status"><div class="urg-wrap">
        <div class="urg" role="img" aria-label="Waiting by urgency: ${counts.critical} critical, ${counts.high} high, ${counts.standard} standard">
          ${['critical', 'high', 'standard'].map(b => `<div class="seg ${b}" style="flex:${counts[b]} 1 0"></div>`).join('')}</div>
        <div class="urg-legend">${['critical', 'high', 'standard'].map(b => `<span><i class="dot ${b}"></i><b>${counts[b]}</b>${b}</span>`).join('')}<span class="muted">waiting</span></div></div>
      <div class="stats"><div class="stat"><b>${active.length}</b><span>on the way</span></div><div class="stat"><b>${seats}</b><span>free seats</span></div></div></div>`;

    let planHtml = '';
    if (ui.plan) {
      const pl = ui.plan;
      planHtml += `<div class="card" id="plan"><h2>Dispatch plan (preview)</h2>
        <p class="muted">Nothing is sent until you confirm. Stretcher cases go to ambulances only.</p>`;
      if (pl.assignments.length) {
        planHtml += `<table><thead><tr><th>Who</th><th>Vehicle</th><th>Destination</th><th>Seats</th></tr></thead><tbody>
          ${pl.assignments.map(x => `<tr><td><b>${esc(x.person.initials)}</b> ${bandChip(x.band)}</td><td>${esc(x.vehicle.label)}</td><td>${esc(x.shelter ? x.shelter.name : 'no open shelter')}${x.warning ? `<div class="flags">Check: ${esc(x.warning)}</div>` : ''}</td><td class="num">${T.seatsNeeded(x.person)}</td></tr>`).join('')}</tbody></table>`;
      } else planHtml += `<div class="empty">No pickups can be assigned right now.</div>`;
      if (pl.unassigned.length) planHtml += `<div class="note"><b>Not assigned:</b> ${pl.unassigned.map(u => `${esc(u.person.initials)} (${esc(u.reason)})`).join('; ')}</div>`;
      if (pl.waitingCallback.length) planHtml += `<div class="note"><b>Waiting for a callback before dispatch:</b> ${pl.waitingCallback.map(p => esc(p.id)).join(', ')}</div>`;
      planHtml += `<div class="row" style="margin-top:12px"><button class="btn" data-act="confirm"${pl.assignments.length ? '' : ' disabled'}>Confirm and send SMS</button>
        <button class="btn light" data-act="discard">Discard</button></div></div>`;
    }

    html += `<div class="grid2"><div>`;
    html += planHtml;
    html += `<div class="card"><div class="row"><h2>Priority queue</h2><span class="spacer"></span>
      <button class="btn" data-act="preview"${rows.length ? '' : ' disabled'}>Preview dispatch plan</button></div>`;
    if (!rows.length) html += `<div class="empty">Nobody is waiting.${a ? '' : ' Raise an alert to rank the care list.'}</div>`;
    else {
      html += `<table class="queue"><thead><tr><th>#</th><th>Who</th><th>Urgency</th><th>Score</th><th>Waiting</th><th>Actions</th></tr></thead><tbody>`;
      rows.forEach((r, i) => {
        const p = r.person, res = r.result, open = ui.expanded.has(p.id);
        html += `<tr class="q-${res.band}"><td>${i + 1}</td>
          <td class="who"><b>${esc(p.initials)}</b> &middot; ${esc(wardName(p.ward))}
            <div class="chips">
            ${p.unverified ? `<span class="chip unverified">${p.source === 'sms' ? 'SMS request' : 'missed call'}, unverified</span>` : ''}
            ${p.pinned ? '<span class="chip warn">pinned by coordinator</span>' : ''}
            ${p.pressed1 ? '<span class="chip">asked for transport</span>' : ''}
            ${p.unverified && !p.callbackDone ? '<span class="chip warn">callback needed</span>' : ''}
            ${p.unverified && p.callbackDone ? '<span class="chip ok">callback done</span>' : ''}</div></td>
          <td>${bandChip(res.band)}<div class="flags">${esc(res.flags.join('; '))}</div></td>
          <td class="score-cell"><div class="num">${res.score}</div>
            <div class="meter" title="Marks at 35 (high) and 60 (critical)"><i class="${res.band}" style="width:${res.score}%"></i><b style="left:35%"></b><b style="left:60%"></b></div></td>
          <td>${res.waitMin} min</td>
          <td><div class="actions">
            <button class="btn light small" data-act="why" data-id="${esc(p.id)}">${open ? 'Hide' : 'Why?'}</button>
            <button class="btn light small" data-act="pin" data-id="${esc(p.id)}">${p.pinned ? 'Unpin' : 'Pin'}</button>
            ${p.unverified && !p.callbackDone ? `<button class="btn small" data-act="callback" data-id="${esc(p.id)}">Called back</button>` : ''}
            ${p.unverified ? `<button class="btn light small" data-act="dismiss" data-id="${esc(p.id)}">Dismiss</button>` : ''}
          </div></td></tr>`;
        if (open) {
          html += `<tr class="breakdown"><td></td><td colspan="5"><table><thead><tr><th>Factor</th><th>Reading</th><th>Points</th><th></th></tr></thead><tbody>
            ${res.factors.map(f => `<tr><td>${esc(f.label)}</td><td>${esc(f.why)}</td><td class="score">${f.points} / ${f.weight}</td><td style="width:90px"><div class="meter"><i style="background:var(--water);width:${f.v * 100}%"></i></div></td></tr>`).join('')}
            <tr><td>Waiting bonus</td><td>${res.waitMin} min</td><td class="score">${res.waitPoints} / ${T.WAIT_MAX_BONUS}</td><td></td></tr>
            ${res.floorApplied ? `<tr><td colspan="4">Unverified floor applied: raised to ${T.UNVERIFIED_FLOOR} so this request is not buried.</td></tr>` : ''}
            ${p.detailsUnknown ? '<tr><td colspan="4">Missed call: no details yet. The score reflects the ward only until the callback.</td></tr>' : ''}
            </tbody></table></td></tr>`;
        }
      });
      html += `</tbody></table>`;
    }
    html += `</div>`;

    html += `<div class="card"><h2>On the way and delivered</h2>`;
    if (!state.dispatched.length) html += `<div class="empty">No dispatches yet. Preview a plan to send the first pickups.</div>`;
    else html += `<table><thead><tr><th>Who</th><th>Vehicle</th><th>To</th><th></th></tr></thead><tbody>${state.dispatched.slice().reverse().map(d => `
      <tr class="${d.delivered ? 'dispatched' : ''}"><td><b>${esc(d.initials)}</b> &middot; ${esc(wardName(d.ward))}</td>
      <td>${esc((state.vehicles.find(v => v.id === d.vehicleId) || {}).label)}</td><td>${esc(d.shelterId ? (state.shelters.find(s => s.id === d.shelterId) || {}).name : 'n/a')}</td>
      <td>${d.delivered ? '<span class="chip ok">delivered</span>' : `<button class="btn small" data-act="deliver" data-id="${esc(d.id)}">Mark delivered</button>`}</td></tr>`).join('')}</tbody></table>`;
    html += `</div></div>`;

    html += `<div><div class="card"><h2>Ward map</h2>${mapSVG(rows)}
      <div class="legend"><span>Ring: highest urgency waiting</span><span>Square: shelter, dashed if its data is stale</span><span>Triangle: vehicle</span></div>
      <p class="muted" style="margin-top:8px">The dispatcher sees wards only. A woman's address and phone go to her assigned driver at dispatch, not to this screen.</p></div>
      <div class="card"><h2>Vehicles</h2><table><thead><tr><th>Vehicle</th><th>Type</th><th>Free seats</th></tr></thead><tbody>
      ${state.vehicles.map(v => `<tr><td>${esc(v.id)} &middot; ${esc(v.label)}</td><td>${esc(v.type)}</td><td class="num">${v.seatsFree} / ${v.seats}</td></tr>`).join('')}</tbody></table></div>
      <div class="card"><details><summary>Audit log (${state.audit.length})</summary>
      ${state.audit.length ? `<table style="margin-top:8px"><tbody>${state.audit.slice(0, 25).map(x => `<tr><td>${fmtTime(x.ts)}</td><td>${esc(x.role)}</td><td>${esc(x.action)}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">Nothing logged yet.</div>'}
      </details></div></div></div>`;
    el.innerHTML = html;
  }

  function mapSVG(rows) {
    const S = 40, a = state.alert, now = Date.now();
    const byWard = wardSummary(rows);
    const col = { critical: '#f26a3d', high: '#e8a317', standard: '#8aa6bb' };
    let s = `<svg class="map" viewBox="0 0 800 560" role="img" aria-label="Map of wards, shelters and vehicles">`;
    for (let k = 0; k <= 20; k += 5) s += `<line x1="${k * S}" y1="0" x2="${k * S}" y2="560" stroke="#dbe6f0"/>`;
    for (let k = 0; k <= 14; k += 5) s += `<line x1="0" y1="${k * S}" x2="800" y2="${k * S}" stroke="#dbe6f0"/>`;
    [5, 10, 15].forEach(k => { s += `<text x="${k * S + 5}" y="552" font-size="11" fill="#8aa0b3">${k} km</text>`; });
    s += `<polyline points="0,150 200,175 420,125 620,165 800,140" fill="none" stroke="#bcdaf0" stroke-width="24" stroke-linecap="round"/>
          <polyline points="0,150 200,175 420,125 620,165 800,140" fill="none" stroke="#7db2da" stroke-width="2" stroke-dasharray="2 8" stroke-linecap="round"/>
          <text x="10" y="128" font-size="12" fill="#4f86b3">river</text>`;
    state.dispatched.filter(d => !d.delivered && d.shelterId).forEach(d => {
      const w = wardOf(d.ward), sh = state.shelters.find(x => x.id === d.shelterId);
      if (w && sh) s += `<line x1="${w.pos.x * S}" y1="${w.pos.y * S}" x2="${sh.pos.x * S}" y2="${sh.pos.y * S}" stroke="#2fb594" stroke-width="2.5" stroke-dasharray="6 5"/>`;
    });
    D.WARDS.forEach(w => {
      const hz = a ? (a.hazard[w.code] ?? 0) : 0;
      const fill = hz >= 0.6 ? '#a8cfec' : hz >= 0.3 ? '#cfe4f5' : '#f7fafd';
      const info = byWard[w.code];
      const blocked = a && a.blocked.includes(w.code);
      s += `<g><circle cx="${w.pos.x * S}" cy="${w.pos.y * S}" r="30" fill="${fill}" stroke="${info ? col[info.best] : '#a9bccd'}" stroke-width="${info ? 4 : 2}"${blocked ? ' stroke-dasharray="5 4"' : ''}/>
        <text x="${w.pos.x * S}" y="${w.pos.y * S - 2}" text-anchor="middle" font-size="14" font-weight="700" fill="#16212c">${w.code}</text>
        <text x="${w.pos.x * S}" y="${w.pos.y * S + 14}" text-anchor="middle" font-size="12" fill="#3d4f60">${info ? info.n + ' waiting' : '-'}</text>
        <text x="${w.pos.x * S}" y="${w.pos.y * S + 46}" text-anchor="middle" font-size="11" fill="#5b6e7f">${esc(w.name)}${blocked ? ' (road blocked)' : ''}</text></g>`;
    });
    state.shelters.forEach(sh => {
      const st = T.shelterStatus(sh, now);
      const c = !sh.open ? '#a9b6c2' : st.rank >= 70 ? '#2fb594' : st.rank >= 45 ? '#f2b01e' : '#f26a3d';
      s += `<g><rect x="${sh.pos.x * S - 14}" y="${sh.pos.y * S - 14}" width="28" height="28" rx="4" fill="${c}" ${st.stale ? 'stroke="#16212c" stroke-width="2" stroke-dasharray="4 3"' : ''}/>
        <text x="${sh.pos.x * S}" y="${sh.pos.y * S + 5}" text-anchor="middle" font-size="12" font-weight="700" fill="#08121b">${sh.id}</text>
        <text x="${sh.pos.x * S}" y="${sh.pos.y * S + 30}" text-anchor="middle" font-size="11" fill="#3d4f60">${esc(sh.name)}</text></g>`;
    });
    state.vehicles.forEach(v => {
      const x = v.pos.x * S, y = v.pos.y * S;
      s += `<g><polygon points="${x},${y - 11} ${x + 10},${y + 8} ${x - 10},${y + 8}" fill="#16212c"/><text x="${x + 13}" y="${y + 5}" font-size="11" fill="#16212c">${esc(v.id)}</text></g>`;
    });
    return s + `</svg>`;
  }

  function renderRegistry() {
    const el = $('#tab-registry');
    if (ui.role === 'dispatch') {
      if (!state.alert) {
        el.innerHTML = `<div class="card"><h2>Care list locked</h2><p class="muted">The care list opens for dispatch only while an alert is active. Raise one from the Dispatch tab. Every unlock is written to the audit log.</p></div>`;
        return;
      }
      el.innerHTML = `<div class="card"><h2>Care list (dispatcher view)</h2>
        <p class="muted">Initials, ward and need flags only. No address, no phone. ${state.registry.length} records unlocked at ${fmtTime(state.alert.raisedAt)}.</p>
        <table><thead><tr><th>ID</th><th>Initials</th><th>Ward</th><th>Need</th></tr></thead><tbody>
        ${state.registry.map(p => `<tr><td>${esc(p.id)}</td><td>${esc(p.initials)}</td><td>${esc(wardName(p.ward))}</td><td>${esc(describeNeed(p))}</td></tr>`).join('')}</tbody></table></div>`;
      return;
    }
    const list = state.registry.filter(p => ui.ward === 'ALL' || p.ward === ui.ward);
    el.innerHTML = `<div class="grid2"><div class="card"><h2>Add a woman to the care list (with her consent)</h2>
      <form class="grid" data-form="register" autocomplete="off">
        <label class="f">Initials<input name="initials" maxlength="6" required placeholder="e.g. S.K."></label>
        <label class="f">Ward<select name="ward">${D.WARDS.map(w => `<option value="${w.code}">${w.code} ${esc(w.name)}</option>`).join('')}</select></label>
        <label class="f">Age<input name="age" type="number" min="10" max="110" required></label>
        <label class="f">Weeks pregnant<input name="preg" type="number" min="1" max="42" placeholder="leave empty if not"></label>
        <label class="f">Weeks since birth<input name="post" type="number" min="0" max="52" placeholder="leave empty if not"></label>
        <label class="f">Infants with her<input name="infants" type="number" min="0" max="5" value="0"></label>
        <label class="f">Mobility<select name="mobility"><option value="independent">Independent</option><option value="assisted">Needs assistance</option><option value="wheelchair">Wheelchair</option><option value="bedridden">Bedridden</option></select></label>
        <label class="f">Phone (optional)<input name="phone" inputmode="tel" placeholder="optional"></label>
        <label class="f wide">Medical needs<span class="checks" style="font-weight:400">
          <label><input type="checkbox" name="med" value="oxygen"> oxygen</label>
          <label><input type="checkbox" name="med" value="dialysis"> dialysis</label>
          <label><input type="checkbox" name="med" value="insulin"> insulin</label>
          <label><input type="checkbox" name="med" value="highRiskPregnancy"> high-risk pregnancy</label>
          <label><input type="checkbox" name="med" value="other"> other</label></span></label>
        <label class="f wide">Landmark / address note (released only to the assigned driver)<input name="addr" maxlength="120"></label>
        <label class="f wide" style="flex-direction:row;align-items:center;gap:8px;font-weight:400"><input type="checkbox" name="consent" required> She has agreed to be on the care list and knows how her details are used</label>
        <div class="wide"><button class="btn" type="submit">Add to care list</button></div>
      </form></div>
      <div class="card"><div class="row"><h2>On the care list (${list.length})</h2><span class="spacer"></span>
        <label class="f" style="flex-direction:row;align-items:center;gap:6px">Ward<select data-change="wardfilter"><option value="ALL">All</option>${D.WARDS.map(w => `<option value="${w.code}"${ui.ward === w.code ? ' selected' : ''}>${w.code}</option>`).join('')}</select></label></div>
      <table><thead><tr><th>Who</th><th>Need</th><th></th></tr></thead><tbody>
      ${list.map(p => `<tr><td><b>${esc(p.initials)}</b> &middot; ${esc(wardName(p.ward))}<br><span class="muted">${esc(p.addressNote)}</span></td><td>${esc(describeNeed(p))}${p.age != null && p.age < 75 ? `<br><span class="muted">age ${p.age}</span>` : ''}</td>
        <td><button class="btn light small" data-act="withdraw" data-id="${esc(p.id)}" title="Remove her record">Withdraw</button></td></tr>`).join('') || '<tr><td colspan="3" class="empty">No records.</td></tr>'}
      </tbody></table></div></div>`;
  }
  function submitRegister(form) {
    const f = new FormData(form);
    const num = (k) => (f.get(k) === '' || f.get(k) == null ? null : Number(f.get(k)));
    const initials = String(f.get('initials') || '').trim();
    const age = num('age'), preg = num('preg'), post = num('post');
    if (!initials) return toast('Enter her initials.');
    if (!f.get('consent')) return toast('Consent is required to add her.');
    if (age == null || age < 10 || age > 110) return toast('Enter a realistic age.');
    if (preg != null && (preg < 1 || preg > 42)) return toast('Pregnancy weeks must be between 1 and 42.');
    if (preg != null && post != null) return toast('Use either weeks pregnant or weeks since birth, not both.');
    const ward = f.get('ward'), w = wardOf(ward);
    const n = state.registry.length;
    const p = {
      id: 'R' + String(state.seq.r++).padStart(2, '0'), initials, ward,
      pos: { x: w.pos.x + ((n * 37) % 11 - 5) / 10, y: w.pos.y + ((n * 53) % 11 - 5) / 10 },
      addressNote: String(f.get('addr') || '').trim() || 'No note', phone: String(f.get('phone') || '').trim(),
      age, pregnancyWeeks: preg, postpartumWeeks: post, infants: num('infants') || 0,
      mobility: f.get('mobility'), medical: f.getAll('med'), consent: true, source: 'registry'
    };
    state.registry.push(p);
    audit(`Added ${p.initials} in ${wardName(ward)} (consent recorded)`);
    queueIfOffline(`Added ${p.initials}`);
    toast(`${initials} added to the care list.`);
    commit();
  }

  const COND_LABEL = { security: 'Security', water: 'Clean water', medical: 'Medical readiness', sanitation: 'Private sanitation' };
  const condTone = (v) => (v >= 0.7 ? '' : v >= 0.45 ? 'low' : 'bad');
  function renderShelters() {
    const el = $('#tab-shelters');
    const now = Date.now();
    const vol = ui.role === 'volunteer';
    const ordered = state.shelters.map(s => ({ s, st: T.shelterStatus(s, now) })).sort((a, b) => b.st.rank - a.st.rank);
    let html = '';
    if (vol) html += `<div class="card row"><label class="f" style="flex-direction:row;align-items:center;gap:8px">I am at<select data-change="myshelter">${state.shelters.map(s => `<option value="${s.id}"${s.id === ui.myShelter ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
      <span class="muted">You can update only your own shelter. Stale data lowers a shelter's rank until someone confirms it.</span></div>`;
    else html += `<p class="muted" style="margin-bottom:14px">Shelters ranked by safety. Volunteers report the conditions, and a shelter's rank drops as its last update gets older.</p>`;
    html += `<div class="grid2">`;
    ordered.forEach(({ s, st }) => {
      const edit = vol && s.id === ui.myShelter;
      const lv = T.supplyLevels(s);
      const tone = st.rank >= 70 ? 'ok' : st.rank >= 45 ? 'warn' : 'bad';
      html += `<div class="card"><div class="shelter-head"><div style="flex:1;min-width:0"><h3>${esc(s.name)}</h3>
        <div class="row" style="margin-top:4px">${s.open ? '' : '<span class="chip bad">closed</span>'}${st.stale ? '<span class="chip warn">stale data</span>' : ''}<span class="muted">${s.occupied} of ${s.capacity} occupied</span></div></div>
        <div class="rank ${tone}"><b>${Math.round(st.rank)}</b><small>safety</small></div></div>
        <p class="muted" style="margin:8px 0 0">Updated ${st.hours < 1 ? 'under an hour' : st.hours + ' h'} ago${st.penalty ? `, rank reduced by ${st.penalty} for the age of the data` : ''}.</p>`;
      if (!edit) {
        html += `<div class="cond">${['security', 'water', 'medical', 'sanitation'].map(k => `<span>${COND_LABEL[k]}</span><div class="meter"><i class="${condTone(s[k])}" style="width:${s[k] * 100}%"></i></div><span class="pct">${Math.round(s[k] * 100)}%</span>`).join('')}</div>
          <h3 class="sub">Supplies</h3><p class="sublegend">Bars show stock against par. Marks at 20% (critical) and 50% (low).</p>
          <div class="sup">${lv.map(x => `<span>${KIT[x.key]}</span><div class="meter"><i class="${x.level === 'ok' ? '' : x.level === 'low' ? 'low' : 'bad'}" style="width:${Math.min(100, x.pct * 100)}%"></i><b style="left:20%"></b><b style="left:50%"></b></div><span class="have">${x.have} / ${x.par}${x.level === 'ok' ? '' : ` <span class="chip ${x.level === 'critical' ? 'bad' : 'warn'}">${x.level}</span>`}</span>`).join('')}</div>`;
      } else {
        html += `<form class="grid" data-form="shelter" data-id="${s.id}" style="margin-top:12px">
          <label class="f">Occupied<input name="occupied" type="number" min="0" max="${s.capacity * 2}" value="${s.occupied}"></label>
          <label class="f">Open<select name="open"><option value="1"${s.open ? ' selected' : ''}>Open</option><option value="0"${s.open ? '' : ' selected'}>Closed</option></select></label>
          ${['security', 'water', 'medical', 'sanitation'].map(k => `<label class="f">${COND_LABEL[k]} (%)<input name="${k}" type="number" min="0" max="100" step="5" value="${Math.round(s[k] * 100)}"></label>`).join('')}
          ${Object.keys(KIT).map(k => `<label class="f">${KIT[k]} in stock (par ${T.supplyLevels(s).find(x => x.key === k).par})<input name="stock_${k}" type="number" min="0" value="${s.stock[k] ?? 0}"></label>`).join('')}
          <div class="wide row"><button class="btn" type="submit">Save update</button>
          <button class="btn light" type="button" data-act="confirmfresh" data-id="${s.id}">Nothing changed, confirm</button></div></form>`;
      }
      html += `</div>`;
    });
    el.innerHTML = html + `</div>`;
  }
  function submitShelter(form) {
    const s = state.shelters.find(x => x.id === form.dataset.id);
    const f = new FormData(form);
    const pct = (k) => Math.min(1, Math.max(0, Number(f.get(k)) / 100));
    const occ = Number(f.get('occupied'));
    if (!Number.isFinite(occ) || occ < 0) return toast('Enter how many people are in the shelter.');
    s.occupied = occ; s.open = f.get('open') === '1';
    ['security', 'water', 'medical', 'sanitation'].forEach(k => { s[k] = pct(k); });
    Object.keys(KIT).forEach(k => { s.stock[k] = Math.max(0, Number(f.get('stock_' + k)) || 0); });
    s.lastUpdated = Date.now();
    audit(`Shelter update: ${s.name}`);
    queueIfOffline(`Shelter update: ${s.name}`);
    toast(isOffline() ? 'Saved on this device. It will sync when you are back online.' : 'Shelter update saved.');
    commit();
  }

  function renderPhone() {
    const el = $('#tab-phone');
    el.innerHTML = `<div class="grid2"><div class="card"><h2>A woman's phone (simulated)</h2>
      <p class="muted">Any handset works: text a short code, or give a missed call. No app needed. A neighbour can do this on her behalf.</p>
      <div class="phone"><div class="statusbar"><span>${SIM_PHONE}</span><span>Aashray helpline</span></div><div class="screen">${state.thread.length ? state.thread.map(m => `<div class="bubble ${m.dir === 'out' ? 'out' : 'in'}">${esc(m.text)}</div>`).join('') : '<div class="muted">No messages yet.</div>'}</div></div>
      <form class="row" data-form="sms" style="margin-top:12px" autocomplete="off"><label class="f" style="flex:1">Text to the helpline<input name="text" placeholder="HELP W3 P34 M" required></label><button class="btn" type="submit" style="align-self:end">Send SMS</button></form>
      <div class="row" style="margin-top:6px"><span class="muted">Try:</span>
        ${['HELP W3 P34 M', 'HELP W5 O M X', 'HELP W7 B', 'HELP W9'].map(t => `<button class="btn light small" data-act="fillsms" data-text="${t}">${t}</button>`).join('')}</div>
      <p class="muted">Codes: HELP &lt;ward&gt; then P&lt;weeks&gt; pregnant, O elderly, M cannot walk unaided, B infant, X medical need.</p>
      <hr style="border:0;border-top:1px solid var(--line);margin:12px 0">
      <div class="row"><label class="f" style="flex-direction:row;align-items:center;gap:6px">Missed call from ward<select id="mcward">${D.WARDS.map(w => `<option value="${w.code}">${w.code} ${esc(w.name)}</option>`).join('')}</select></label>
        <button class="btn" data-act="missedcall">Give a missed call</button>
        <button class="btn light" data-act="press1"${ui.lastMissed ? '' : ' disabled'}>Press 1: transport</button>
        <button class="btn light" data-act="press2"${ui.lastMissed ? '' : ' disabled'}>Press 2: nearest shelter</button></div>
      <div class="row" style="margin-top:8px"><button class="btn light small" data-act="clearthread">Clear this phone</button></div></div>
      <div class="card smslog"><h2>Gateway log</h2>
      <p class="note">Simulated gateway. No real SMS is sent. In a deployment this is an SMS aggregator and IVR provider, which needs a telecom partnership.</p>
      ${state.smsLog.length ? state.smsLog.slice(0, 40).map(m => `<div class="item"><span class="to">To ${esc(m.to)}</span> <span class="chip ${m.status === 'sent' ? 'ok' : 'sync'}">${m.status}</span> <span class="muted">${fmtTime(m.ts)}</span><br>${esc(m.text).replace(/\n/g, '<br>')}</div>`).join('') : '<div class="empty">No outgoing messages yet. They appear here when you confirm a dispatch.</div>'}
      </div></div>`;
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const id = b.dataset.id;
    // put focus back after re-render
    ui.refocus = `[data-act="${b.dataset.act}"]` + (id ? `[data-id="${id}"]` : '') + (b.dataset.ward ? `[data-ward="${b.dataset.ward}"]` : '') + (b.dataset.tab ? `[data-tab="${b.dataset.tab}"]` : '');
    switch (b.dataset.act) {
      case 'cyclehazard': {
        if (!state.alert) return;
        const cur = state.alert.hazard[b.dataset.ward] ?? 0;
        const next = HAZARD_LEVELS[(HAZARD_LEVELS.findIndex(l => l[0] === cur) + 1) % HAZARD_LEVELS.length];
        state.alert.hazard[b.dataset.ward] = next[0];
        audit(`Hazard for ${wardName(b.dataset.ward)} set to ${next[1]}`); queueIfOffline('Hazard level changed'); commit();
        return;
      }
      case 'toggleroad': {
        if (!state.alert) return;
        const set = new Set(state.alert.blocked), on = !set.has(b.dataset.ward);
        on ? set.add(b.dataset.ward) : set.delete(b.dataset.ward);
        state.alert.blocked = [...set];
        audit(`Road ${on ? 'blocked' : 'reopened'}: ${wardName(b.dataset.ward)}`); queueIfOffline('Road status changed'); commit();
        return;
      }
      case 'tab': ui.tab = b.dataset.tab; return renderAll();
      case 'raise': return raiseAlert();
      case 'standdown': return standDown();
      case 'why': ui.expanded.has(id) ? ui.expanded.delete(id) : ui.expanded.add(id); return renderPanel();
      case 'pin': {
        const p = state.registry.find(x => x.id === id) || state.requests.find(x => x.id === id);
        if (p) { p.pinned = !p.pinned; audit(`Manual override: ${p.pinned ? 'pinned' : 'unpinned'} ${p.initials} (${wardName(p.ward)})`); commit(); }
        return;
      }
      case 'callback': {
        const p = state.requests.find(x => x.id === id);
        if (p) { p.callbackDone = true; audit(`Callback done for ${p.id} (${wardName(p.ward)}), cleared for dispatch`); commit(); }
        return;
      }
      case 'dismiss': {
        const p = state.requests.find(x => x.id === id);
        if (p) { p.dismissed = true; audit(`Request ${p.id} dismissed`); commit(); }
        return;
      }
      case 'preview': ui.plan = makePlan(); return renderPanel();
      case 'discard': ui.plan = null; return renderPanel();
      case 'confirm': return confirmPlan();
      case 'deliver': {
        const d = state.dispatched.find(x => x.id === id);
        if (d && !d.delivered) {
          d.delivered = true;
          const v = state.vehicles.find(x => x.id === d.vehicleId); if (v) v.seatsFree = Math.min(v.seats, v.seatsFree + d.seats);
          const s = state.shelters.find(x => x.id === d.shelterId); if (s) s.occupied += d.seats;
          audit(`Delivered ${d.initials}`); commit();
        }
        return;
      }
      case 'withdraw': {
        const i = state.registry.findIndex(x => x.id === id);
        if (i >= 0) { const p = state.registry.splice(i, 1)[0]; audit(`Record withdrawn: ${p.initials} (${wardName(p.ward)})`); queueIfOffline(`Withdrew ${p.initials}`); commit(); }
        return;
      }
      case 'confirmfresh': {
        const s = state.shelters.find(x => x.id === id);
        if (s) { s.lastUpdated = Date.now(); audit(`Shelter confirmed unchanged: ${s.name}`); queueIfOffline(`Shelter confirmed: ${s.name}`); toast('Confirmed.'); commit(); }
        return;
      }
      case 'fillsms': { const i = $('[name="text"]'); if (i) { i.value = b.dataset.text; i.focus(); } return; }
      case 'missedcall': return handleMissedCall($('#mcward').value);
      case 'press1': return pressKey(1);
      case 'press2': return pressKey(2);
      case 'clearthread': state.thread = []; ui.lastMissed = null; return commit();
    }
  });
  document.addEventListener('change', (e) => {
    const t = e.target, k = t.dataset && t.dataset.change; if (!k) return;
    if (k === 'wardfilter') { ui.ward = t.value; renderPanel(); }
    else if (k === 'myshelter') { ui.myShelter = t.value; renderPanel(); }
  });
  document.addEventListener('submit', (e) => {
    const f = e.target.closest('form[data-form]'); if (!f) return;
    e.preventDefault();
    if (f.dataset.form === 'register') submitRegister(f);
    else if (f.dataset.form === 'shelter') submitShelter(f);
    else if (f.dataset.form === 'sms') { const v = f.elements.text.value.trim(); if (v) handleSms(v); }
  });
  $('#role').addEventListener('change', (e) => { ui.role = e.target.value; ui.plan = null; renderAll(); });
  $('#offline').addEventListener('change', (e) => { ui.autoOffline = false; setOffline(e.target.checked); });
  $('#reset').addEventListener('click', () => { state = fresh(); ui.plan = null; ui.expanded.clear(); ui.lastMissed = null; save(); toast('Demo reset to the sample data.'); renderAll(); });
  // real network loss acts like the offline switch
  window.addEventListener('offline', () => { if (!state.offline) { ui.autoOffline = true; setOffline(true); } });
  window.addEventListener('online', () => { if (ui.autoOffline) { ui.autoOffline = false; setOffline(false); } });
  setInterval(() => { if (ui.tab === 'dispatch' && !ui.plan) renderPanel(); }, 30000);

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* app still works online */ });
  }
  function route() {
    const demo = location.hash === '#demo';
    document.body.classList.toggle('on-landing', !demo);
    window.scrollTo(0, 0);
  }
  window.addEventListener('hashchange', route);

  renderAll();
  route();
})();
