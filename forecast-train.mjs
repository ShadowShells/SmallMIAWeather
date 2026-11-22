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
import { STATION, trendBucket, skyState, RING, upwindDelta } from "./forecast-engine.js";

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
  const q = `station=${STATION.iemId}&data=tmpf&data=drct&data=sknt&data=gust&data=skyc1&data=skyc2&data=skyc3&data=skyl1&data=skyl2&data=skyl3&data=wxcodes&year1=${yr - YEARS}&month1=1&day1=1&year2=${yr}&month2=12&day2=31&tz=Etc/GMT%2B5&format=onlycomma&latlon=no&missing=empty&trace=empty&report_type=3&report_type=4`;
  const csv = await text("https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?" + q);
  const days = {};
  const lines = csv.trim().split("\n"), H = lines[0].split(","), ix = (k) => H.indexOf(k);
  for (const ln of lines.slice(1)) {
    const c = ln.split(","), valid = c[1], tf = c[ix("tmpf")], dr = c[ix("drct")], sk = c[ix("sknt")];
    const T = parseFloat(tf); if (isNaN(T)) continue;
    const d = valid.slice(0, 10);
    const dd = Math.abs(doy(d) - t); if (Math.min(dd, 365 - dd) > WIN || d >= todayS) continue;
    const num = (x) => (x === "" || x == null ? null : parseFloat(x));
    (days[d] ||= []).push({ h: +valid.slice(11, 13), m: +valid.slice(14, 16), T: Math.round(T), dr: parseFloat(dr), sk: parseFloat(sk), g: num(c[ix("gust")]),
      sky: skyState([c[ix("skyc1")], c[ix("skyc2")], c[ix("skyc3")]], [num(c[ix("skyl1")]), num(c[ix("skyl2")]), num(c[ix("skyl3")])], c[ix("wxcodes")]) });
  }

  // --- ring stations, hourly (for the upwind signal) ---
  const ringT = {}; // ringT[st][day][hour] = last whole-°F temp in that hour
  try {
    const rq = Object.keys(RING).map((s2) => `station=${s2}`).join("&") + `&data=tmpf&year1=${yr - YEARS}&month1=1&day1=1&year2=${yr}&month2=12&day2=31&tz=Etc/GMT%2B5&format=onlycomma&latlon=no&missing=empty&report_type=3`;
    const rc = await text("https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?" + rq);
    for (const ln of rc.trim().split("\n").slice(1)) {
      const [st, valid, tf] = ln.split(","), T = parseFloat(tf); if (isNaN(T)) continue;
      const d = valid.slice(0, 10), dd = Math.abs(doy(d) - t); if (Math.min(dd, 365 - dd) > WIN || d >= todayS) continue;
      ((ringT[st] ||= {})[d] ||= {})[+valid.slice(11, 13)] = Math.round(T);
    }
  } catch (e) { console.log("ring history failed:", e.message); }
  // usual station-minus-KMIA difference by hour (removes siting bias)
  const bsum = {};
  for (const [d, obs] of Object.entries(days)) for (const o of obs) for (const st in ringT) {
    const T = ringT[st][d]?.[o.h]; if (T == null || o.m < 40) continue;
    const k = ((bsum[st] ||= {})[o.h] ||= [0, 0]); k[0] += T - o.T; k[1]++;
  }
  const upwindBias = {};
  for (const st in bsum) { upwindBias[st] = {}; for (const h in bsum[st]) if (bsum[st][h][1] >= 30) upwindBias[st][h] = Math.round((bsum[st][h][0] / bsum[st][h][1]) * 10) / 10; }
  const upPairs = []; // [hour, delta, rise, cellKey]

  const rise = {}, spike = {}, nc = {}, spikeG = { gusty: [], calm: [] }, peakH = {}; // rise[sector][hour] = [CLI - maxSoFar]; spike[sector] = [CLI - dayMaxHourly]
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
    const gusty = obs.some((o) => o.h >= 9 && o.h <= 17 && (o.g ?? 0) >= 18);
    spikeG[gusty ? "gusty" : "calm"].push(hi - dayMax);
    const pk = obs.find((o) => o.T === dayMax && o.h >= 8); if (pk) for (const s of [sec, "all"]) push(peakH, s, pk.h + pk.m / 60);
    for (const h of HOURS) {
      const so = obs.filter((o) => o.h <= h); if (!so.length) continue;
      const r = hi - Math.max(...so.map((o) => o.T));
      for (const s of [sec, "all"]) { (rise[s] ||= {}); push(rise[s], h, r); }
      // nowcast table: condition on last-hour trend and current sky
      const cur = so[so.length - 1], prev = obs.filter((o) => o.h <= h - 1).at(-1);
      if (cur.h < h - 1 || !prev) continue;
      const tb = trendBucket(cur.T - prev.T);
      for (const k of [`${tb}|${cur.sky}`, `${tb}|*`, `*|${cur.sky}`]) { (nc[h] ||= {}); push(nc[h], k, r); }
      if (h >= 9 && h <= 15 && cur.sk > 0 && !isNaN(cur.dr)) {
        const temps = {}; for (const st in ringT) temps[st] = ringT[st][d]?.[h] ?? null;
        const u = upwindDelta(cur.T, cur.dr, temps, upwindBias, h);
        if (u?.delta != null) upPairs.push([h, u.delta, r, [`${tb}|${cur.sky}`, `${tb}|*`, `*|${cur.sky}`]]);
      }
    }
  }
  const pacing = {};
  for (const s in rise) { pacing[s] = {}; for (const h in rise[s]) if (rise[s][h].length >= 25) pacing[s][h] = pmf(rise[s][h], -1, 15); }
  const nowcast = {};
  for (const h in nc) { nowcast[h] = {}; for (const k in nc[h]) if (nc[h][k].length >= 30) nowcast[h][k] = pmf(nc[h][k], -1, 15); }
  // upwind effect: slope of (rise - its nowcast-cell mean) on the upwind anomaly
  let upwind = null;
  {
    const xs = [], ys = [];
    for (const [h, dl, r, keys] of upPairs) { const k = keys.find((k2) => nowcast[h]?.[k2]); if (!k) continue; xs.push(dl); ys.push(r - nowcast[h][k].mean); }
    if (xs.length >= 100) {
      const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
      const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0), sxy = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0), syy = ys.reduce((a, y) => a + (y - my) ** 2, 0);
      const b = sxy / sxx, rr = sxy / Math.sqrt(sxx * syy), se = Math.sqrt(Math.max(0, (syy - b * sxy) / (xs.length - 2)) / sxx);
      // only use it if it's clearly real (|t| > 2); shrink toward 0 otherwise
      upwind = { b: Math.abs(b / se) > 2 ? Math.round(b * 100) / 100 : 0, raw: Math.round(b * 100) / 100, t: Math.round((b / se) * 10) / 10, r: Math.round(rr * 100) / 100, n: xs.length, sdDelta: Math.round(Math.sqrt(sxx / xs.length) * 10) / 10 };
    }
  }
  const qt = (a, p) => { const b = [...a].sort((x, y) => x - y); return Math.round(b[Math.min(b.length - 1, Math.floor(p * b.length))] * 10) / 10; };
  const peak = {}; for (const s in peakH) if (peakH[s].length >= 25) peak[s] = { p25: qt(peakH[s], 0.25), p50: qt(peakH[s], 0.5), p75: qt(peakH[s], 0.75), p90: qt(peakH[s], 0.9), n: peakH[s].length };
  const spikeGust = {}; for (const k in spikeG) if (spikeG[k].length >= 25) { const a = spikeG[k]; spikeGust[k] = { ...pmf(a, -2, 4), ge1: Math.round((a.filter((x) => x >= 1).length / a.length) * 100) / 100 }; }
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
    pacing, spike: spikeOut, nowcast, peak, spikeGust, upwind, upwindBias,
    selfcal: { today: cal((e) => e.morning || e.first), tomorrow: cal((e) => e.first) },
  };
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = await train();
  writeFileSync("forecast_learned.json", JSON.stringify(out));
  console.log("trained on", out.daysUsed, "days;", "spike E:", JSON.stringify(out.spike["E/onshore"]), "selfcal:", JSON.stringify(out.selfcal.today));
}
