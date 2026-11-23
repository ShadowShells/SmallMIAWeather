// Trains the morning "call model": for each cutoff time (8:00, 9:00, 10:30, 12:00, 1:30 EST),
// a ridge regression from what was known then -> the official CLI high, fit on ~2 years of days.
// Inputs per day: KMIA hourly obs up to the cutoff, each model's day-ahead high (Open-Meteo
// previous-runs), GFS MOS 06Z max, NBM text 13Z afternoon temps. Writes into forecast_learned.json.
// Also reports an honest walk-forward test: MAE and how often the best 2°F bracket hit.
import { readFileSync, writeFileSync } from "node:fs";
import { STATION, CALL_MODELS, CALL_FEATS, CALL_CUTOFFS, callFeatures, skyState } from "./forecast-engine.js";

const START = "2024-11-20";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, json = false) {
  for (let i = 0; ; i++) {
    const r = await fetch(url);
    if (r.ok) { const t = await r.text(); if (!/Too many requests/i.test(t.slice(0, 100))) return json ? JSON.parse(t) : t; }
    if (i >= 4) throw new Error(`${url.split("?")[0]} HTTP ${r.status}`);
    await sleep(8000 * (i + 1));
  }
}
const csvRows = (txt) => { const L = txt.trim().split("\n"), H = L[0].split(","); return L.slice(1).map((l) => { const c = l.split(","); return Object.fromEntries(H.map((h, i) => [h, c[i]])); }); };
const num = (x) => (x === "" || x == null || x === "M" ? null : +x);

async function loadData(todayS) {
  const y0 = +START.slice(0, 4), y1 = +todayS.slice(0, 4);
  // official highs
  const cli = {};
  for (let y = y0; y <= y1; y++) { const d = await get(`https://mesonet.agron.iastate.edu/json/cli.py?station=${STATION.icao}&year=${y}`, true); for (const r of d.results || []) if (typeof r.high === "number") cli[r.valid] = r.high; }
  // hourly obs
  const [sy, sm, sd] = START.split("-").map(Number), [ty, tm, td] = todayS.split("-").map(Number);
  const q = `station=${STATION.iemId}&data=tmpf&data=dwpf&data=drct&data=sknt&data=skyc1&data=skyc2&data=skyc3&data=skyl1&data=skyl2&data=skyl3&data=wxcodes` +
    `&year1=${sy}&month1=${sm}&day1=${sd}&year2=${ty}&month2=${tm}&day2=${td}&tz=Etc/GMT%2B5&format=onlycomma&latlon=no&missing=empty&trace=empty&report_type=3&report_type=4`;
  const obs = {};
  for (const r of csvRows(await get("https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?" + q))) {
    const T = num(r.tmpf); if (T == null) continue;
    const d = r.valid.slice(0, 10), hm = +r.valid.slice(11, 13) * 60 + +r.valid.slice(14, 16);
    const cld = skyState([r.skyc1, r.skyc2, r.skyc3], [num(r.skyl1), num(r.skyl2), num(r.skyl3)], r.wxcodes) === "cloudy/wet" ? 1 : 0;
    (obs[d] ||= []).push({ hm, T: Math.round(T), dew: num(r.dwpf) != null ? Math.round(num(r.dwpf)) : null, cld, drct: num(r.drct), sknt: num(r.sknt) });
  }
  // MOS: GFS MOS 06Z max, NBM text 13Z max of 18Z/21Z temps (both for the same day)
  const mav06 = {}, nbs13 = {};
  await sleep(3000);
  for (const r of csvRows(await get(`https://mesonet.agron.iastate.edu/cgi-bin/request/mos.py?station=${STATION.icao}&model=GFS&sts=${START}T00:00Z&ets=${todayS}T23:00Z&format=csv`))) {
    if (r.runtime?.slice(11, 13) !== "06" || num(r.n_x) == null || r.ftime.slice(11, 13) !== "00") continue;
    const d = new Date(Date.parse(r.ftime.slice(0, 10) + "T00:00:00Z") - 86400e3).toISOString().slice(0, 10);
    if (r.runtime.slice(0, 10) === d) mav06[d] = num(r.n_x);
  }
  for (let y = y0; y <= y1; y++) {
    await sleep(3000);
    for (const r of csvRows(await get(`https://mesonet.agron.iastate.edu/cgi-bin/request/mos.py?station=${STATION.icao}&model=NBS&sts=${y}-01-01T00:00Z&ets=${y + 1}-01-01T00:00Z&format=csv`))) {
      if (r.runtime?.slice(11, 13) !== "13" || r.runtime.slice(0, 10) !== r.ftime.slice(0, 10) || !["15", "18", "21"].includes(r.ftime.slice(11, 13))) continue;
      const d = r.runtime.slice(0, 10), t = num(r.tmp); if (t != null) nbs13[d] = Math.max(nbs13[d] ?? -99, t);
    }
  }
  // models' day-ahead highs
  const models = {};
  const qs = new URLSearchParams({ latitude: STATION.lat, longitude: STATION.lon, timezone: "Etc/GMT+5", start_date: START, end_date: todayS,
    models: CALL_MODELS.join(","), hourly: "temperature_2m_previous_day1", temperature_unit: "fahrenheit" });
  const om = await get("https://previous-runs-api.open-meteo.com/v1/forecast?" + qs, true);
  for (const m of CALL_MODELS) {
    const arr = om.hourly[`temperature_2m_previous_day1_${m}`] || [];
    om.hourly.time.forEach((t, i) => { const d = t.slice(0, 10); if (arr[i] != null) (models[d] ||= {})[m] = Math.max(models[d]?.[m] ?? -99, arr[i]); });
  }
  return { cli, obs, mav06, nbs13, models };
}

/* ---- ridge regression (standardized features), alpha by contiguous-fold CV ---- */
function solve(A, b) { // Gaussian elimination
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
function fitRidge(X, y, alpha) {
  const n = X.length, p = X[0].length;
  const mean = Array(p).fill(0), std = Array(p).fill(0);
  for (const r of X) r.forEach((v, j) => (mean[j] += v / n));
  for (const r of X) r.forEach((v, j) => (std[j] += (v - mean[j]) ** 2 / n));
  for (let j = 0; j < p; j++) std[j] = Math.sqrt(std[j]) || 1;
  const Z = X.map((r) => r.map((v, j) => (v - mean[j]) / std[j])), ym = y.reduce((a, b) => a + b, 0) / n;
  const A = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => Z.reduce((s, r) => s + r[i] * r[j], 0) + (i === j ? alpha : 0)));
  const b = Array.from({ length: p }, (_, i) => Z.reduce((s, r, k) => s + r[i] * (y[k] - ym), 0));
  return { beta: solve(A, b), mean, std, intercept: ym };
}
const pred = (M, x) => x.reduce((s, v, j) => s + M.beta[j] * ((v - M.mean[j]) / M.std[j]), M.intercept);
const ncdf = (z) => { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };
function bracketHit(mu, sd, y) { // average over both bracket parities (Kalshi's 2°F brackets start on odd or even)
  let h = 0;
  for (const par of [0, 1]) {
    let best = null, bp = -1;
    for (let lo = Math.floor(mu) - 6; lo <= Math.floor(mu) + 6; lo++) { if (((lo % 2) + 2) % 2 !== par) continue; const p = ncdf((lo + 1.5 - mu) / sd) - ncdf((lo - 0.5 - mu) / sd); if (p > bp) { bp = p; best = lo; } }
    if (y >= best && y <= best + 1) h += 0.5;
  }
  return h;
}

export async function trainCall() {
  const now = new Date(Date.now() + STATION.utcOffset * 3600e3), todayS = now.toISOString().slice(0, 10);
  const D = await loadData(todayS);
  const days = Object.keys(D.cli).filter((d) => d >= START && d < todayS && D.obs[d] && D.models[d]).sort();
  const out = { trained: new Date().toISOString(), days: days.length, cutoffs: {} };
  for (const cut of CALL_CUTOFFS) {
    const ex = [];
    for (const d of days) {
      const doy = Math.floor((Date.parse(d + "T00:00:00Z") - Date.UTC(+d.slice(0, 4), 0, 0)) / 86400e3);
      const f = callFeatures({ rows: D.obs[d], cut, models: D.models[d], mav06: D.mav06[d], nbs13: cut >= 570 ? D.nbs13[d] : null, doy });
      if (f) ex.push({ d, x: CALL_FEATS.map((k) => f[k]), y: D.cli[d] });
    }
    if (ex.length < 150) continue;
    // alpha by 5 contiguous folds
    const alphas = [0.3, 1, 3, 10, 30, 100, 300], K = 5, fold = Math.ceil(ex.length / K);
    let best = null;
    for (const a of alphas) {
      const res = [];
      for (let k = 0; k < K; k++) {
        const te = ex.slice(k * fold, (k + 1) * fold), tr = [...ex.slice(0, k * fold), ...ex.slice((k + 1) * fold)];
        const M = fitRidge(tr.map((e) => e.x), tr.map((e) => e.y), a); for (const e of te) res.push(e.y - pred(M, e.x));
      }
      const mse = res.reduce((s, r) => s + r * r, 0) / res.length;
      if (!best || mse < best.mse) best = { a, mse, sd: Math.sqrt(mse) };
    }
    // honest walk-forward test over the last ~9 months (refit monthly on everything before)
    const wf = [], months = [...new Set(ex.map((e) => e.d.slice(0, 7)))].slice(-9);
    for (const mo of months) {
      const tr = ex.filter((e) => e.d < mo + "-01"), te = ex.filter((e) => e.d.startsWith(mo)); if (tr.length < 120) continue;
      const M = fitRidge(tr.map((e) => e.x), tr.map((e) => e.y), best.a);
      const rr = tr.map((e) => e.y - pred(M, e.x)), sd = Math.sqrt(rr.reduce((s, r) => s + r * r, 0) / rr.length);
      for (const e of te) { const mu = pred(M, e.x); wf.push({ err: mu - e.y, hit: bracketHit(mu, sd, e.y) }); }
    }
    const M = fitRidge(ex.map((e) => e.x), ex.map((e) => e.y), best.a);
    out.cutoffs[cut] = { feats: CALL_FEATS, beta: M.beta.map((b) => Math.round(b * 1e4) / 1e4), mean: M.mean.map((v) => Math.round(v * 1e3) / 1e3), std: M.std.map((v) => Math.round(v * 1e3) / 1e3),
      intercept: Math.round(M.intercept * 1e3) / 1e3, alpha: best.a, sd: Math.round(best.sd * 100) / 100, n: ex.length,
      cvMAE: wf.length ? Math.round((wf.reduce((s, w) => s + Math.abs(w.err), 0) / wf.length) * 100) / 100 : null,
      cvHit: wf.length ? Math.round((wf.reduce((s, w) => s + w.hit, 0) / wf.length) * 100) : null, testDays: wf.length };
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cm = await trainCall();
  let L = {}; try { L = JSON.parse(readFileSync("forecast_learned.json", "utf8")); } catch { /* new */ }
  L.callModel = cm; writeFileSync("forecast_learned.json", JSON.stringify(L));
  for (const [c, m] of Object.entries(cm.cutoffs)) console.log(`${Math.floor(c / 60)}:${String(c % 60).padStart(2, "0")}  n=${m.n} alpha=${m.alpha} sd=${m.sd}  walk-forward: MAE ${m.cvMAE}, bracket hit ${m.cvHit}% (${m.testDays} days)`);
}
