// Daily "learning" job (run by forecast-update.mjs when forecast_learned.json is stale,
// or by hand: node forecast-train.mjs). Writes forecast_learned.json:
//
// 1. pacing  — from ~12 years of KMIA hourly METARs + the NWS CLI high, for days within
//              ±30 days of today's date: for each local hour and wind sector, how much
//              higher did the CLI high end up than the hourly-METAR high so far?
//              (whole-°F probability table). This is what "is it pacing for 82?" uses.
// 2. spike   — CLI high minus the day's max hourly METAR, by sector: how often the
//              1-minute data printed above every hourly ob (the Nov 19 81→82 case).
// 3. selfcal — the dashboard's own recent misses (forecast_log.json): mean error of
//              the morning and night-before calls, shrunk and clamped, fed back in.
import { readFileSync, writeFileSync } from "node:fs";
import { STATION } from "./forecast-engine.js";

const WIN = 30, YEARS = 12, HOURS = [6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
export const sectorOf = (wd) => wd == null ? "calm" : (wd >= 290 || wd < 20) ? "N/NW" : wd < 150 ? "E/onshore" : wd < 240 ? "S/SW" : "W/land";

async function text(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url.split("?")[0]} HTTP ${r.status}`); return r.text(); }
async function json(url) { const r = await fetch(url); if (!r.ok) throw new Error(`${url.split("?")[0]} HTTP ${r.status}`); return r.json(); }

const doy = (s) => { const d = new Date(s + "T00:00:00Z"); return Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400e3); };

function pmf(vals, lo, hi) {
  const c = {}; for (let k = lo; k <= hi; k++) c[k] = 0;
  for (const v of vals) c[Math.max(lo, Math.min(hi, v))]++;
  const n = vals.length; const p = {};
  for (const k in c) p[k] = Math.round((c[k] / n) * 1000) / 1000;
  return { n, p, mean: Math.round((vals.reduce((a, b) => a + b, 0) / n) * 100) / 100 };
}

export async function train({ logPath = "forecast_log.json" } = {}) {
  const now = new Date(Date.now() + STATION.utcOffset * 3600e3);
  const todayS = now.toISOString().slice(0, 10), t = doy(todayS), yr = now.getUTCFullYear();

  // --- CLI highs (official) ---
  const cli = {};
  await Promise.all(Array.from({ length: YEARS + 1 }, (_, i) => yr - YEARS + i).map(async (y) => {
    try { const d = await json(`https://mesonet.agron.iastate.edu/json/cli.py?station=${STATION.icao}&year=${y}`); for (const r of d.results || []) if (typeof r.high === "number") cli[r.valid] = r.high; } catch { /* skip year */ }
  }));

  // --- hourly METARs (routine + specials), local standard time ---
  const q = `station=${STATION.iemId}&data=tmpf&data=drct&data=sknt&year1=${yr - YEARS}&month1=1&day1=1&year2=${yr}&month2=12&day2=31&tz=Etc/GMT%2B5&format=onlycomma&latlon=no&missing=empty&trace=empty&report_type=3&report_type=4`;
  const csv = await text("https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?" + q);
  const days = {};
  for (const ln of csv.trim().split("\n").slice(1)) {
    const [, valid, tf, dr, sk] = ln.split(",");
    const T = parseFloat(tf); if (isNaN(T)) continue;
    const d = valid.slice(0, 10);
    const dd = Math.abs(doy(d) - t); if (Math.min(dd, 365 - dd) > WIN || d >= todayS) continue;
    (days[d] ||= []).push({ h: +valid.slice(11, 13), m: +valid.slice(14, 16), T: Math.round(T), dr: parseFloat(dr), sk: parseFloat(sk) });
  }

  const rise = {}, spike = {}; // rise[sector][hour] = [CLI - maxSoFar]; spike[sector] = [CLI - dayMaxHourly]
  const push = (o, k, v) => (o[k] ||= []).push(v);
  let used = 0;
  for (const [d, obs] of Object.entries(days)) {
    const hi = cli[d]; if (hi == null || obs.length < 18) continue;
    let u = 0, v = 0;
    for (const o of obs) if (o.h >= 10 && o.h <= 16 && o.sk > 0 && !isNaN(o.dr)) { u += o.sk * Math.sin(o.dr * Math.PI / 180); v += o.sk * Math.cos(o.dr * Math.PI / 180); }
    const sec = u === 0 && v === 0 ? "calm" : sectorOf((Math.atan2(u, v) * 180 / Math.PI + 360) % 360);
    const dayMax = Math.max(...obs.map((o) => o.T));
    if (hi - dayMax < -2) continue; // bad CLI / missing obs
    used++;
    for (const s of [sec, "all"]) push(spike, s, hi - dayMax);
    for (const h of HOURS) {
      const so = obs.filter((o) => o.h <= h); if (!so.length) continue;
      const r = hi - Math.max(...so.map((o) => o.T));
      for (const s of [sec, "all"]) { (rise[s] ||= {}); push(rise[s], h, r); }
    }
  }
  const pacing = {};
  for (const s in rise) { pacing[s] = {}; for (const h in rise[s]) if (rise[s][h].length >= 25) pacing[s][h] = pmf(rise[s][h], -1, 15); }
  const spikeOut = {};
  for (const s in spike) if (spike[s].length >= 25) {
    const a = spike[s]; spikeOut[s] = { ...pmf(a, -2, 4), ge1: Math.round((a.filter((x) => x >= 1).length / a.length) * 100) / 100 };
  }

  // --- self-calibration from the dashboard's own track record ---
  let log = {}; try { log = JSON.parse(readFileSync(logPath, "utf8")); } catch { /* none yet */ }
  const cal = (pick) => {
    const errs = Object.entries(log).filter(([d, e]) => e.actual != null && d < todayS).slice(-14)
      .map(([d, e]) => { const s = pick(e); const m = s?.meanRaw ?? s?.mean; return m == null ? null : { d, err: Math.round((e.actual - m) * 10) / 10 }; }).filter(Boolean);
    const n = errs.length; if (!n) return { n: 0, bias: 0, adj: 0, days: [] };
    const b = errs.reduce((s, x) => s + x.err, 0) / n;
    const adj = n >= 5 ? Math.max(-2, Math.min(2, b * n / (n + 5))) : 0;
    return { n, bias: Math.round(b * 100) / 100, adj: Math.round(adj * 100) / 100, days: errs };
  };

  const out = {
    trained: new Date().toISOString(), station: STATION.icao, window: `±${WIN} days of ${todayS.slice(5)}, ${yr - YEARS}–${yr}`, daysUsed: used,
    pacing, spike: spikeOut,
    selfcal: { today: cal((e) => e.morning || e.first), tomorrow: cal((e) => e.first) },
  };
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await train();
  writeFileSync("forecast_learned.json", JSON.stringify(out));
  console.log("trained on", out.daysUsed, "days;", "spike E:", JSON.stringify(out.spike["E/onshore"]), "selfcal:", JSON.stringify(out.selfcal.today));
}
