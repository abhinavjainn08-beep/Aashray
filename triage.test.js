const test = require('node:test');
const assert = require('node:assert');
const T = require('../triage.js');

const NOW = 1_700_000_000_000;
const shelters = [
  { id: 'S1', open: true, pos: { x: 10, y: 5 }, capacity: 100, occupied: 10, security: 1, water: 1, medical: 1, sanitation: 1, lastUpdated: NOW, stock: {} },
  { id: 'S2', open: true, pos: { x: 2, y: 2 }, capacity: 100, occupied: 10, security: 0.4, water: 0.5, medical: 0.2, sanitation: 0.3, lastUpdated: NOW, stock: {} }
];
const ctx = { hazardByWard: { W1: 0.5 }, blockedWards: [], shelters, now: NOW };
const base = { id: 'a', ward: 'W1', pos: { x: 10, y: 5 }, age: 30, mobility: 'independent', infants: 0, medical: [], pregnancyWeeks: null };

test('weights sum to 100 for non-wait factors', () => {
  assert.strictEqual(Object.values(T.WEIGHTS).reduce((a, b) => a + b, 0), 100);
});

test('healthy adult at the shelter scores only hazard points', () => {
  const r = T.scoreWoman(base, ctx);
  assert.strictEqual(r.score, 6);          // 0.5 * 12, distance 0
  assert.strictEqual(r.band, 'standard');
});

test('36+ week pregnancy outranks 20 week pregnancy', () => {
  const a = T.scoreWoman({ ...base, pregnancyWeeks: 37 }, ctx).score;
  const b = T.scoreWoman({ ...base, pregnancyWeeks: 21 }, ctx).score;
  assert.ok(a > b);
});

test('bedridden elderly on oxygen outranks a late-term pregnancy in a severe flood', () => {
  const severe = { ...ctx, hazardByWard: { W1: 0.9 } };
  const far = { x: 4, y: 5 };   // about 6 km from the nearest open shelter
  const frail = { ...base, id: 'frail', pos: far, age: 82, mobility: 'bedridden', medical: ['oxygen'] };
  const preg = { ...base, id: 'preg', pos: far, pregnancyWeeks: 38 };
  const ranked = T.rankQueue([preg, frail], severe);
  assert.strictEqual(ranked[0].person.id, 'frail');
  assert.ok(ranked[0].result.score >= 60, 'score was ' + ranked[0].result.score);
});

test('blocked road maxes the distance factor', () => {
  const near = T.scoreWoman(base, { ...ctx, blockedWards: ['W1'] });
  assert.strictEqual(near.factors.find(f => f.key === 'distance').points, 8);
});

test('wait bonus grows and is capped at 10', () => {
  const w = (min) => T.scoreWoman({ ...base, requestedAt: NOW - min * 60000 }, ctx).waitPoints;
  assert.strictEqual(w(0), 0);
  assert.strictEqual(w(60), 5);
  assert.strictEqual(w(600), 10);
});

test('medical factor: extra conditions add 0.15 and cap at 1', () => {
  assert.strictEqual(T.medicalFactor(['insulin']), 0.7);
  assert.ok(Math.abs(T.medicalFactor(['insulin', 'other']) - 0.85) < 1e-9);
  assert.strictEqual(T.medicalFactor(['oxygen', 'dialysis']), 1);
});

test('unverified request gets the floor and is flagged', () => {
  const r = T.scoreWoman({ ...base, unverified: true }, ctx);
  assert.strictEqual(r.score, T.UNVERIFIED_FLOOR);
  assert.ok(r.floorApplied);
});

test('ranking is deterministic: earlier request wins a tie', () => {
  const p1 = { ...base, id: 'p1', requestedAt: NOW - 10 * 60000 };
  const p2 = { ...base, id: 'p2', requestedAt: NOW - 10 * 60000 };
  const ranked = T.rankQueue([p2, p1], ctx);
  assert.deepStrictEqual(ranked.map(r => r.person.id), ['p1', 'p2']);
});

test('shelter rank drops as data goes stale, and flags at 8 hours', () => {
  const fresh = T.shelterStatus({ ...shelters[0], lastUpdated: NOW }, NOW);
  const old = T.shelterStatus({ ...shelters[0], lastUpdated: NOW - 9 * 3600000 }, NOW);
  assert.strictEqual(fresh.rank, 100);
  assert.ok(old.rank < fresh.rank);
  assert.ok(old.stale && !fresh.stale);
});

test('supply levels: low under 50% of par, critical under 20%', () => {
  // capacity 100 -> par: menstrual 25, formula 8, prenatal 6
  const lv = (stock) => Object.fromEntries(T.supplyLevels({ capacity: 100, stock }).map(x => [x.key, x.level]));
  assert.strictEqual(lv({ menstrual: 4 }).menstrual, 'critical');   // 4/25 = 0.16
  assert.strictEqual(lv({ menstrual: 5 }).menstrual, 'low');        // 5/25 = 0.20, boundary counts as low
  assert.strictEqual(lv({ menstrual: 12 }).menstrual, 'low');       // 0.48
  assert.strictEqual(lv({ menstrual: 13 }).menstrual, 'ok');        // 0.52
  assert.strictEqual(lv({}).formula, 'critical');                   // missing stock counts as zero
});

test('stretcher cases only go to ambulances', () => {
  const vehicles = [
    { id: 'V1', type: 'van', seats: 8, pos: { x: 10, y: 5 } },
    { id: 'V2', type: 'ambulance', seats: 3, pos: { x: 0, y: 0 } }
  ];
  const bedridden = { ...base, id: 'b', mobility: 'bedridden', age: 80 };
  const ranked = T.rankQueue([bedridden], ctx);
  const plan = T.planDispatch(ranked, vehicles, shelters, NOW);
  assert.strictEqual(plan.assignments[0].vehicle.id, 'V2');
});

test('no ambulance free: stretcher case is reported unassigned, not silently dropped', () => {
  const vehicles = [{ id: 'V1', type: 'van', seats: 8, pos: { x: 0, y: 0 } }];
  const ranked = T.rankQueue([{ ...base, id: 'b', mobility: 'bedridden' }], ctx);
  const plan = T.planDispatch(ranked, vehicles, shelters, NOW);
  assert.strictEqual(plan.assignments.length, 0);
  assert.strictEqual(plan.unassigned.length, 1);
});

test('seat capacity is respected across a ranked queue', () => {
  const vehicles = [{ id: 'V1', type: 'van', seats: 2, pos: { x: 10, y: 5 } }];
  const people = [1, 2, 3].map(i => ({ ...base, id: 'p' + i, pregnancyWeeks: 38, requestedAt: NOW - i * 60000 }));
  const plan = T.planDispatch(T.rankQueue(people, ctx), vehicles, shelters, NOW);
  assert.strictEqual(plan.assignments.length, 2);
  assert.strictEqual(plan.unassigned.length, 1);
});

test('SMS parser accepts valid codes', () => {
  const r = T.parseHelpSms('help w3 p34 m', ['W3']);
  assert.ok(r.ok);
  assert.strictEqual(r.pregnancyWeeks, 34);
  assert.strictEqual(r.mobility, 'assisted');
});

test('SMS parser rejects bad input with a reason', () => {
  assert.strictEqual(T.parseHelpSms('hello', ['W3']).ok, false);
  assert.strictEqual(T.parseHelpSms('HELP W9', ['W3']).ok, false);
  assert.strictEqual(T.parseHelpSms('HELP W3 P99', ['W3']).ok, false);
  assert.strictEqual(T.parseHelpSms('HELP W3 ZZ', ['W3']).ok, false);
});

test('band: term pregnancy in a severely flooded ward is never "standard"', () => {
  const severe = { ...ctx, hazardByWard: { W1: 0.9 } };
  const r = T.scoreWoman({ ...base, pregnancyWeeks: 38 }, severe);
  assert.ok(r.score < T.BAND_CRITICAL);          // the score alone would not make her critical
  assert.notStrictEqual(r.band, 'standard');
  assert.ok(r.flags.includes('late pregnancy / newborn'));
});

test('band: stretcher case in a badly flooded ward is critical, but not forced in a dry ward', () => {
  const frail = { ...base, mobility: 'bedridden', age: 40 };
  const wet = T.scoreWoman(frail, { ...ctx, hazardByWard: { W1: 0.9 } });
  const dry = T.scoreWoman(frail, { ...ctx, hazardByWard: { W1: 0 } });
  assert.strictEqual(wet.band, 'critical');
  assert.notStrictEqual(dry.band, 'critical');
});

test('band: within one band, the higher score ranks first', () => {
  const severe = { ...ctx, hazardByWard: { W1: 0.9 } };
  const a = T.scoreWoman({ ...base, age: 76 }, severe);              // flagged by age only
  const b = T.scoreWoman({ ...base, pregnancyWeeks: 38 }, severe);
  assert.ok(b.score > a.score);
  assert.deepStrictEqual(T.rankQueue([{ ...base, id: 'a', age: 76 }, { ...base, id: 'b', pregnancyWeeks: 38 }], severe).map(r => r.person.id), ['b', 'a']);
});

test('queue sorts by band first: a critical stretcher case outranks a higher-scoring high-band case', () => {
  const wet = { ...ctx, hazardByWard: { W1: 0.6 } };
  const dialysis = { ...base, id: 'd', medical: ['dialysis'], age: 72, mobility: 'assisted' };   // stretcher rule -> critical (49.0)
  const flagged = { ...base, id: 'f', pregnancyWeeks: 38, medical: ['insulin'] };               // high band (49.7)
  const d = T.scoreWoman(dialysis, wet), f = T.scoreWoman(flagged, wet);
  assert.ok(f.score > d.score, 'premise: flagged case scores higher');
  assert.strictEqual(d.band, 'critical');
  assert.strictEqual(f.band, 'high');
  assert.deepStrictEqual(T.rankQueue([flagged, dialysis], wet).map(r => r.person.id), ['d', 'f']);
});

test('a walking woman does not take the ambulance seats a stretcher case needs', () => {
  const vehicles = [
    { id: 'A', type: 'ambulance', seats: 2, pos: { x: 0, y: 0 } },
    { id: 'V', type: 'van', seats: 1, pos: { x: 40, y: 40 } }
  ];
  const walker = { ...base, id: 'w', pregnancyWeeks: 38, requestedAt: NOW - 3600000 };
  const bed = { ...base, id: 'b', mobility: 'bedridden', requestedAt: NOW };
  const ranked = T.rankQueue([walker, bed], ctx);
  const plan = T.planDispatch(ranked, vehicles, shelters, NOW);
  const byId = Object.fromEntries(plan.assignments.map(a => [a.person.id, a.vehicle.id]));
  assert.strictEqual(byId.b, 'A');
  assert.strictEqual(byId.w, 'V');
});

test('shelter room is used up as people are assigned to it', () => {
  const tiny = [{ id: 'S', name: 'Tiny', pos: { x: 1, y: 1 }, capacity: 2, occupied: 0, open: true, security: 1, water: 1, medical: 1, sanitation: 1, lastUpdated: NOW, stock: {} }];
  const vehicles = [{ id: 'V', type: 'van', seats: 8, pos: { x: 1, y: 1 } }];
  const people = [1, 2, 3].map(i => ({ ...base, id: 'p' + i, pregnancyWeeks: 38, requestedAt: NOW - i * 1000 }));
  const plan = T.planDispatch(T.rankQueue(people, ctx), vehicles, tiny, NOW);
  assert.strictEqual(plan.assignments.filter(a => a.shelter).length, 2);
  assert.ok(plan.assignments.some(a => a.warning));
});

test('oxygen-dependent woman goes to a shelter with medical cover', () => {
  const two = [
    { id: 'near', name: 'Near', pos: { x: 1, y: 1 }, capacity: 50, occupied: 0, open: true, security: 1, water: 1, medical: 0.1, sanitation: 1, lastUpdated: NOW, stock: {} },
    { id: 'far', name: 'Far', pos: { x: 9, y: 9 }, capacity: 50, occupied: 0, open: true, security: 0.6, water: 0.6, medical: 0.9, sanitation: 0.6, lastUpdated: NOW, stock: {} }
  ];
  const vehicles = [{ id: 'A', type: 'ambulance', seats: 3, pos: { x: 1, y: 1 } }];
  const w = { ...base, id: 'o', medical: ['oxygen'], pos: { x: 1, y: 1 } };
  const plan = T.planDispatch(T.rankQueue([w], ctx), vehicles, two, NOW);
  assert.strictEqual(plan.assignments[0].shelter.id, 'far');
});
