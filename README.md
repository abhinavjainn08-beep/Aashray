# Aashray (आश्रय)

**Flood rescue that reaches the most vulnerable women first.**

Built by Abhinav Jain, second-year CSE (AIML), VIT Bhopal University, for the IEEE-MSB SAMWAD Ideathon, Problem Statement 5 (women's emergency evacuation and critical care).

- Live demo: https://abhinavjainn08-beep.github.io/Aashray/
- Explanation video: https://youtu.be/vdGZuFWJsvc

## The problem

When a flood comes, evacuation usually works first come, first served. That leaves behind the women who cannot simply walk to the road: someone in late pregnancy, someone on oxygen at home, someone in a wheelchair or bedridden. The nearest shelter may be full, cut off by water, or out of what she needs. Many women have no smartphone, and the data network is the first thing to fail.

## The idea

Three steps:

1. **Before the monsoon**, a health worker adds a woman to a care list, with her consent. The list holds initials, ward, and what she would need to get out (a stretcher, a wheelchair, help walking, oxygen, and so on).
2. **When a flood alert is raised**, every woman gets a score from 0 to 100, and anyone can open "Why?" to see exactly where each point came from.
3. **A coordinator previews and confirms a dispatch plan**, and each driver receives one SMS with who to pick up and which shelter to go to.

The score suggests an order. A person decides: the coordinator can pin anyone, and every override is written to an audit log.

## How the score works

| Factor | Max points |
| --- | --- |
| Medical dependency (oxygen, dialysis, insulin) | 25 |
| Pregnancy, newborn, infants | 25 |
| Mobility (stretcher, wheelchair, needs help walking) | 20 |
| Age | 10 |
| Flood level in her ward | 12 |
| Distance to the nearest open shelter | 8 |
| Waiting time | 10 |

The total is capped at 100. Women are placed in a band first, and ranked by score inside it:

- **Critical:** score 60 or more, or a stretcher case in a ward with high flood hazard.
- **High:** score 35 or more, or a clinical flag.
- **Standard:** everyone else.

Because band comes first, a critical woman at 51 ranks above a high-priority woman at 53. This is on purpose.

Requests that arrive by SMS are unverified. They start at 40 points and need a callback before dispatch.

The weights are my starting assumptions. In a real pilot they would be set with health workers.

## What the prototype does

- **Care list** with a consent tick box. Dispatchers see initials and ward only. The address goes only to the assigned driver.
- **Ranked queue** with a "Why?" breakdown for every woman and a pin option for coordinators.
- **Dispatch planner.** Stretcher cases go only to ambulances. Ambulance seats are held for later stretcher cases. Shelter room is tracked as women are assigned, infants included. Oxygen, dialysis and women 36 or more weeks pregnant go to a shelter with medical cover.
- **Shelters and supplies.** Each shelter has a safety score (security 30, water 25, medical 25, sanitation 20), which drops by up to 10 points as its data ages. Menstrual, formula and prenatal kits are tracked against target levels.
- **Phone / SMS simulator.** Text `HELP W3 P34 M` (ward, weeks pregnant, mobility) or give a missed call. Replies are in English and Hindi, and a wrong message gets a clear error.
- **Offline mode.** A service worker keeps the app working without signal and holds changes until it is back.
- **Roles:** health worker, dispatcher, volunteer.
- **Landing page slider** that shows how the river level changes the order.

## Run it locally

No build step and no dependencies.

```
git clone https://github.com/abhinavjainn08-beep/Aashray.git
cd Aashray
python3 -m http.server 8765
```

Then open http://localhost:8765/ and press "Open the demo".

## Tests

The scoring and planning logic is in `triage.js` as plain functions, with unit tests.

```
node --test test/triage.test.js
```

`test/e2e.py` is a Playwright script that clicks through the whole demo.

## Files

| File | What it is |
| --- | --- |
| `index.html`, `style.css` | Page and styles |
| `landing.js` | Front page and the river slider |
| `app.js` | The console: tabs, roles, forms |
| `triage.js` | Scoring, bands, dispatch planner, SMS parser |
| `data.js` | Sample wards, women, shelters and vehicles |
| `sw.js`, `manifest.webmanifest` | Offline support and install |
| `test/` | Unit tests and the end-to-end script |

## Limits

- SMS and IVR are simulated. A real deployment would need an SMS gateway and an IVR provider.
- All data is sample data, stored in one browser. It is not shared between devices, and there is no login.
- The score weights and supply target levels are assumptions that need checking with health workers and relief coordinators.
- The map is schematic, not real geography.

## Next steps

1. Pilot in one district with its health workers.
2. Connect an SMS gateway and an IVR provider.
3. Add a backend with login and shared data.
4. Tune the weights with clinicians.
5. Train health workers and volunteers on the care list.
