// sample data only, none of this is real. coordinates are km on a 20 x 14 grid
(function (root) {
  'use strict';

  const WARDS = [
    { code: 'W1', name: 'Riverside',    pos: { x: 3,  y: 3 } },
    { code: 'W2', name: 'Low Bazaar',   pos: { x: 7,  y: 2.5 } },
    { code: 'W3', name: 'Old Bridge',   pos: { x: 11, y: 3 } },
    { code: 'W4', name: 'Tail Village', pos: { x: 16, y: 3.5 } },
    { code: 'W5', name: 'Mill Colony',  pos: { x: 4,  y: 8 } },
    { code: 'W6', name: 'Market Road',  pos: { x: 9,  y: 8.5 } },
    { code: 'W7', name: 'Canal Basti',  pos: { x: 14, y: 9 } },
    { code: 'W8', name: 'Hill Crest',   pos: { x: 18, y: 11 } }
  ];

  const MIN = 60000, HR = 3600000;

  function seedShelters(now) {
    return [
      { id: 'S1', name: 'Govt Girls School', pos: { x: 8.5, y: 6 }, capacity: 220, occupied: 60, open: true,
        security: 0.9, water: 0.9, medical: 0.5, sanitation: 0.8, lastUpdated: now - 1 * HR,
        stock: { menstrual: 70, formula: 12, prenatal: 10 } },
      { id: 'S2', name: 'Hill Crest Community Hall', pos: { x: 17.5, y: 12 }, capacity: 150, occupied: 20, open: true,
        security: 0.5, water: 0.8, medical: 0.2, sanitation: 0.4, lastUpdated: now - 2 * HR,
        stock: { menstrual: 20, formula: 3, prenatal: 2 } },
      { id: 'S3', name: 'PHC Annex', pos: { x: 10, y: 11 }, capacity: 80, occupied: 35, open: true,
        security: 0.7, water: 0.9, medical: 0.95, sanitation: 0.7, lastUpdated: now - 9 * HR,
        stock: { menstrual: 4, formula: 1, prenatal: 5 } },
      { id: 'S4', name: 'Panchayat Bhawan', pos: { x: 3, y: 11 }, capacity: 120, occupied: 50, open: true,
        security: 0.6, water: 0.5, medical: 0.3, sanitation: 0.6, lastUpdated: now - 4 * HR,
        stock: { menstrual: 30, formula: 9, prenatal: 7 } },
      { id: 'S5', name: 'Railway Colony School', pos: { x: 14.5, y: 6 }, capacity: 180, occupied: 90, open: true,
        security: 0.8, water: 0.7, medical: 0.6, sanitation: 0.9, lastUpdated: now - 30 * MIN,
        stock: { menstrual: 60, formula: 10, prenatal: 4 } }
    ];
  }

  function seedVehicles() {
    return [
      { id: 'V1', label: 'Ambulance A', type: 'ambulance', seats: 3, seatsFree: 3, pos: { x: 7, y: 6 },   driver: 'Driver 1', phone: '90000 00001' },
      { id: 'V2', label: 'Ambulance B', type: 'ambulance', seats: 3, seatsFree: 3, pos: { x: 13, y: 8 },  driver: 'Driver 2', phone: '90000 00002' },
      { id: 'V3', label: 'Van C',       type: 'van',       seats: 8, seatsFree: 8, pos: { x: 5, y: 6 },   driver: 'Driver 3', phone: '90000 00003' },
      { id: 'V4', label: 'Van D',       type: 'van',       seats: 8, seatsFree: 8, pos: { x: 15, y: 5 },  driver: 'Driver 4', phone: '90000 00004' }
    ];
  }

  function seedRegistry() {
    const w = (code) => WARDS.find(x => x.code === code).pos;
    const mk = (id, initials, ward, dx, dy, o) => ({
      id, initials, ward, pos: { x: w(ward).x + dx, y: w(ward).y + dy },
      addressNote: o.addr || 'Lane near ward office', phone: o.phone || '',
      age: o.age ?? 30, pregnancyWeeks: o.preg ?? null, postpartumWeeks: o.post ?? null,
      infants: o.inf || 0, mobility: o.mob || 'independent', medical: o.med || [],
      consent: true, source: 'registry'
    });
    return [
      mk('R01', 'S.K.', 'W1',  0.3, 0.4, { age: 27, preg: 38, addr: 'Blue gate, behind temple, lane 2', phone: '90001 10001' }),
      mk('R02', 'M.D.', 'W1', -0.5, 0.2, { age: 81, mob: 'bedridden', med: ['oxygen'], addr: 'Ground floor, near water tank', phone: '90001 10002' }),
      mk('R03', 'A.B.', 'W2',  0.2,-0.3, { age: 24, preg: 31, addr: 'Above tailor shop, main lane' }),
      mk('R04', 'P.S.', 'W2',  0.6, 0.5, { age: 68, mob: 'wheelchair', med: ['insulin'], addr: 'Corner house, red door', phone: '90001 10004' }),
      mk('R05', 'R.T.', 'W3', -0.2, 0.3, { age: 29, post: 2, inf: 1, addr: 'Next to bridge tea stall', phone: '90001 10005' }),
      mk('R06', 'K.N.', 'W3',  0.4,-0.4, { age: 76, mob: 'assisted', addr: 'Hand-pump lane, house 14' }),
      mk('R07', 'V.G.', 'W4',  0.2, 0.2, { age: 26, preg: 22, addr: 'Opposite school boundary wall' }),
      mk('R08', 'L.J.', 'W4', -0.3, 0.5, { age: 34, inf: 2, addr: 'Farm road, third house', phone: '90001 10008' }),
      mk('R09', 'D.R.', 'W5',  0.5, 0.2, { age: 72, mob: 'assisted', med: ['dialysis'], addr: 'Mill gate 2 colony, block C', phone: '90001 10009' }),
      mk('R10', 'N.P.', 'W5', -0.4,-0.3, { age: 25, preg: 36, addr: 'Block A, first floor' }),
      mk('R11', 'S.M.', 'W6',  0.3, 0.3, { age: 58, addr: 'Above pharmacy' }),
      mk('R12', 'H.C.', 'W7',  0.2,-0.2, { age: 79, mob: 'wheelchair', addr: 'Canal bank, house 7', phone: '90001 10012' }),
      mk('R13', 'T.V.', 'W7', -0.3, 0.4, { age: 28, preg: 30, med: ['highRiskPregnancy'], addr: 'Behind grain store', phone: '90001 10013' }),
      mk('R14', 'B.A.', 'W8',  0.2, 0.1, { age: 66, addr: 'Temple steps lane' })
    ];
  }

  const SCENARIO_RIVER_BREACH = {
    name: 'River breach: Riverside, Low Bazaar, Old Bridge and Mill Colony badly hit',
    hazard: { W1: 0.9, W2: 0.9, W3: 0.9, W4: 0.3, W5: 0.6, W6: 0.3, W7: 0.3, W8: 0 },
    blocked: ['W4']
  };

  const api = { WARDS, seedShelters, seedVehicles, seedRegistry, SCENARIO_RIVER_BREACH };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AashrayData = api;
})(typeof window !== 'undefined' ? window : globalThis);
