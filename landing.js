(function () {
  'use strict';
  const T = window.Triage, D = window.AashrayData;
  const root = document.getElementById('try');
  if (!root) return;

  const MED = { oxygen: 'oxygen', dialysis: 'dialysis', insulin: 'insulin', highRiskPregnancy: 'high-risk pregnancy', other: 'medical need' };
  const MOB = { assisted: 'needs help walking', wheelchair: 'wheelchair', bedridden: 'bedridden' };
  const ROW = 76, SHOW = 6;
  const people = D.seedRegistry();
  const shelters = D.seedShelters(Date.now());
  const wardName = (c) => D.WARDS.find(w => w.code === c).name;
  const share = { W1: 1, W2: 1, W3: 1, W4: .35, W5: .7, W6: .35, W7: .35, W8: 0 };

  function need(p) {
    const bits = [];
    if (p.pregnancyWeeks != null) bits.push(p.pregnancyWeeks + ' weeks pregnant');
    if (p.postpartumWeeks != null && p.postpartumWeeks <= 6) bits.push('newborn');
    if (p.infants > 0) bits.push(p.infants + (p.infants > 1 ? ' infants' : ' infant'));
    if (MOB[p.mobility]) bits.push(MOB[p.mobility]);
    if (p.medical.length) bits.push(p.medical.map(m => MED[m] || m).join(', '));
    if (p.age >= 75) bits.push('age ' + p.age);
    return bits.join(', ') || 'no special need';
  }

  const slider = root.querySelector('input[type=range]');
  const readout = root.querySelector('.try-level');
  const list = root.querySelector('.try-list');
  const water = root.querySelector('.try-water');
  list.style.height = ROW * SHOW + 'px';

  const els = new Map();
  people.forEach(p => {
    const li = document.createElement('li');
    li.className = 'try-row';
    li.innerHTML = '<span class="try-rank"></span><span class="try-who"><b></b><small></small></span><span class="try-score"><i></i><em></em></span>';
    li.querySelector('b').textContent = p.initials + ' · ' + wardName(p.ward);
    li.querySelector('small').textContent = need(p);
    list.appendChild(li);
    els.set(p.id, li);
  });

  function levelName(v) { return v < 5 ? 'Calm' : v < 35 ? 'Rising' : v < 65 ? 'High' : 'Severe'; }

  function render() {
    const v = +slider.value / 100;
    const hazard = {};
    for (const w in share) hazard[w] = Math.min(1, v * share[w] * 1.0);
    const rows = T.rankQueue(people.map(p => ({ ...p, requestedAt: 0 })), { hazardByWard: hazard, blockedWards: [], shelters, now: 0 });
    readout.textContent = levelName(+slider.value);
    water.style.setProperty('--lvl', v);
    slider.setAttribute('aria-valuetext', levelName(+slider.value));
    rows.forEach((r, i) => {
      const li = els.get(r.person.id);
      li.style.transform = 'translateY(' + i * ROW + 'px)';
      li.style.opacity = i < SHOW ? 1 : 0;
      li.style.pointerEvents = 'none';
      li.dataset.band = r.result.band;
      li.querySelector('.try-rank').textContent = i + 1;
      li.querySelector('.try-score em').textContent = Math.round(r.result.score);
      li.querySelector('.try-score i').style.width = Math.min(100, r.result.score) + '%';
      li.setAttribute('aria-hidden', i < SHOW ? 'false' : 'true');
    });
  }
  slider.addEventListener('input', render);
  render();
})();
