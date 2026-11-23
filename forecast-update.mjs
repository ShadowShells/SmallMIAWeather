// Scheduled updater (GitHub Action: .github/workflows/forecast.yml).
// 1. Pulls Kalshi odds for today + tomorrow -> kalshi.json (the browser can't call Kalshi: no CORS).
// 2. Runs the full engine server-side -> forecast.json (fallback snapshot for the page).
// 3. Keeps forecast_log.json: first / morning / latest call per day + the CLI actual.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fetchKalshiDirect, runForecast, estNow, fetchCliHighs, fetchHistory, fetchRing, packHistory, STATION } from "./forecast-engine.js";
import { train } from "./forecast-train.mjs";
import { reviewDay } from "./forecast-review.mjs";
import { trainCall } from "./forecast-train-call.mjs";

const now = estNow();
const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const tomorrow = new Date(today.getTime() + 86400e3);
const kalshi = { fetched_utc: new Date().toISOString() };
for (const [k, d] of [["today", today], ["tomorrow", tomorrow]]) {
  try { kalshi[k] = await fetchKalshiDirect(d); } catch (e) { kalshi[k] = { error: e.message, brackets: [] }; }
}
writeFileSync("kalshi.json", JSON.stringify(kalshi, null, 1));
console.log("kalshi:", kalshi.today.peak, "|", kalshi.tomorrow.peak);

// ---- learning: retrain once a day (pacing table, 1-min spike, self-correction) ----
let learned = null;
try { learned = JSON.parse(readFileSync("forecast_learned.json", "utf8")); } catch { /* none */ }
const todayS = today.toISOString().slice(0, 10);
const trainedDay = learned ? new Date(Date.parse(learned.trained) + STATION.utcOffset * 3600e3).toISOString().slice(0, 10) : null;
if (!learned || trainedDay !== todayS || process.env.FORCE_TRAIN) {
  try { learned = await train(); writeFileSync("forecast_learned.json", JSON.stringify(learned)); console.log("retrained on", learned.daysUsed, "days"); }
  catch (e) { console.log("train failed (kept old):", e.message); }
}

// ---- the morning call model: retrain once a day on ~2 years of history ----
if (learned && (!learned.callModel || new Date(Date.parse(learned.callModel.trained) + STATION.utcOffset * 3600e3).toISOString().slice(0, 10) !== todayS)) {
  try { learned.callModel = await trainCall(); writeFileSync("forecast_learned.json", JSON.stringify(learned)); console.log("call model trained on", learned.callModel.days, "days"); }
  catch (e) { console.log("call model training failed (kept old):", e.message); }
}

// ---- IEM cache for the page (official highs, nearby stations, daily history for similar days) ----
let iem = null;
{
  let old = {}; try { old = JSON.parse(readFileSync("iem.json", "utf8")); } catch { /* new */ }
  const [cliNow, ringNow] = await Promise.all([fetchCliHighs().catch(() => ({})), fetchRing().catch(() => null)]);
  let history = old.history || [], histDay = old.historyDay;
  if (!history.length || histDay !== todayS) {
    try { history = packHistory(await fetchHistory(new Date(today.getTime() + 86400e3))); histDay = todayS; } catch (e) { console.log("history failed (kept old):", e.message); }
  }
  let metars = [];
  try { const r = await fetch(`https://aviationweather.gov/api/data/metar?ids=${STATION.icao}&hours=30&format=json`); if (r.ok) metars = (await r.json()).map((m) => ({ rawOb: m.rawOb, obsTime: m.obsTime, temp: m.temp, dewp: m.dewp, wdir: m.wdir, wspd: m.wspd, wgst: m.wgst, wxString: m.wxString, clouds: m.clouds })); } catch { /* skip */ }
  // today's GFS MOS (06Z max) and NBM text (13Z afternoon temps): inputs to the call model
  const mos = { date: todayS, mav06: old.mos?.date === todayS ? old.mos.mav06 : null, nbs13: old.mos?.date === todayS ? old.mos.nbs13 : null };
  const mosRun = async (model, hh) => { const r = await fetch(`https://mesonet.agron.iastate.edu/api/1/mos.json?station=${STATION.icao}&model=${model}&runtime=${todayS}T${hh}:00:00Z`); return r.ok ? (await r.json()).data || [] : []; };
  try { if (mos.mav06 == null) { const d = await mosRun("GFS", "06"); const x = d.find((r) => r.n_x != null && r.ftime.slice(11, 13) === "00" && r.ftime.slice(0, 10) > todayS); if (x) mos.mav06 = +x.n_x; } } catch { /* later */ }
  try { if (mos.nbs13 == null) { const d = await mosRun("NBS", "13"); const v = d.filter((r) => r.ftime.slice(0, 10) === todayS && ["15", "18", "21"].includes(r.ftime.slice(11, 13)) && r.tmp != null).map((r) => +r.tmp); if (v.length) mos.nbs13 = Math.max(...v); } } catch { /* later */ }
  iem = { fetched: new Date().toISOString(), mos, metars, cli: Object.keys(cliNow).length ? cliNow : old.cli || {}, ring: ringNow || {}, history, historyDay: histDay };
  writeFileSync("iem.json", JSON.stringify(iem));
  console.log("iem cache:", Object.keys(iem.cli).length, "CLI days,", Object.keys(iem.ring).length, "ring,", history.length, "history days");
}

// ---- wethr.net: Wethr High with NWS logic (includes the 1-minute data) ----
// The key lives in the repo secret WETHR_API_KEY, never in the code.
let wethr = null;
const KEY = process.env.WETHR_API_KEY;
if (KEY) {
  const url = `https://wethr.net/api/v2/observations.php?station_code=${STATION.icao}&mode=wethr_high&logic=nws`;
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${KEY}`, "X-API-Key": KEY, Accept: "application/json" } });
    const body = await r.text();
    let j = null; try { j = JSON.parse(body); } catch { /* not json */ }
    if (!r.ok) throw new Error(`HTTP ${r.status} ${body.slice(0, 120)}`);
    // find the running high in the response, whatever it is nested under
    const found = {};
    (function walk(o, path) {
      if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) {
        const kp = path ? path + "." + k : k;
        if (typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v))) { if (!(k in found)) found[k] = { v: +v, path: kp }; }
        else walk(v, kp);
      }
    })(j, "");
    const pick = (...names) => { for (const n of names) if (found[n]) return found[n].v; return null; };
    let high = pick("wethr_high", "high", "high_f", "max_temp_f", "max_temp", "temperature_high", "value");
    const potential = pick("potential_high", "potential_high_f");
    const timeKey = Object.keys(found).find((k) => /time/i.test(k));
    const est = (u) => { if (!u) return null; const d = new Date(Date.parse(u.replace(" ", "T") + "Z") + STATION.utcOffset * 3600e3); let h = d.getUTCHours(); return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`; };
    // when the high was first reached (time_of_high_utc is when the CLI/DSM later confirmed it)
    const firsts = Object.values(j?.wethr_high_source_detail || {}).map((x) => x.first_confirmed_utc).filter(Boolean).sort();
    wethr = { date: j?.date || todayS, fetched_utc: new Date().toISOString(), high, potential, time: est(firsts[0] || j?.time_of_high_utc),
      sources: j?.wethr_high_sources || [], low: j?.wethr_low ?? null, lowTime: est(j?.time_of_low_utc), raw: j ?? body.slice(0, 2000) };
    for (const o of [j, j?.data, j?.result, Array.isArray(j?.data) ? j.data[0] : null]) if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) if (typeof v === "string" && /time|source/i.test(k)) (wethr.extra ||= {})[k] = v;
    console.log("wethr high:", high, "potential:", potential);
  } catch (e) { wethr = { date: todayS, fetched_utc: new Date().toISOString(), error: e.message }; console.log("wethr failed:", e.message); }
  // today's 5-min (HF-METAR) + METAR obs: ~2 min behind, vs ~20-30 min for the NWS API
  try {
    const r = await fetch(`https://wethr.net/api/v2/observations.php?station_code=${STATION.icao}&start_time=${encodeURIComponent(new Date(today.getTime() - STATION.utcOffset * 3600e3).toISOString().slice(0, 19).replace("T", " "))}&end_time=${encodeURIComponent(new Date().toISOString().slice(0, 19).replace("T", " "))}`, { headers: { Authorization: `Bearer ${KEY}`, "X-API-Key": KEY, Accept: "application/json" } });
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* */ }
    if (!r.ok || !Array.isArray(j)) throw new Error(`HTTP ${r.status} ${t.slice(0, 200)}`);
    const num = (x) => (x == null || x === "" || x === "NA" ? null : +x);
    // compact 5-min / METAR series for today (observation_time is UTC)
    wethr.obs = j.filter((o) => o.temperature != null).map((o) => ({
      t: o.observation_time.replace(" ", "T") + "Z", c: num(o.temperature), f: num(o.temperature_display),
      lo: num(o.lowest_probable_f), hi: num(o.highest_probable_f), dew: num(o.dew_point),
      wd: num(o.wind_direction), ws: num(o.wind_speed), wg: num(o.wind_gust), metar: !!o.metar_received_at,
    }));
    console.log("wethr obs:", wethr.obs.length, "latest", wethr.obs.at(-1)?.t, wethr.obs.at(-1)?.f);
  } catch (e) { wethr.obsError = e.message; console.log("wethr obs failed:", e.message); }
  writeFileSync("wethr.json", JSON.stringify(wethr, null, 1));
} else console.log("no WETHR_API_KEY secret: skipping wethr");

let fc = null;
try {
  let logPrev = {}; try { logPrev = JSON.parse(readFileSync("forecast_log.json", "utf8")); } catch { /* new */ }
  fc = await runForecast({ inBrowser: false, kalshi, learned, wethr: wethr && !wethr.error ? wethr : null, iem, log: logPrev });
  writeFileSync("forecast.json", JSON.stringify(fc, null, 1));
  console.log("today:", fc.today.summary);
  console.log("tomorrow:", fc.tomorrow.summary);
  if (fc.errors.length) console.log("errors:", fc.errors);
} catch (e) {
  console.log("engine failed (kept previous forecast.json):", e.message);
}

let log = {};
try { log = JSON.parse(readFileSync("forecast_log.json", "utf8")); } catch { /* new */ }
if (fc) {
  for (const k of ["today", "tomorrow"]) {
    const f = fc[k];
    if (!f || f.error) continue;
    const e = (log[f.date] ||= {});
    const snap = { at: `${now.toISOString().slice(5, 10)} ${fc.generatedTxt}`, point: f.point, call: f.call, mean: f.mean, meanRaw: f.meanRaw, sector: f.regime?.sector,
      kalshi_peak: f.kalshi.peak, kalshi_implied: f.kalshi.implied ?? null, nws: f.nws?.high ?? null, analog: f.analogs?.median ?? null };
    e.first ||= snap;
    const H = now.getUTCHours();
    const HM = H * 60 + now.getUTCMinutes();
    // trading-time calls: 9:30 AM (main trade) and 12:30 PM (nowcast check), first update at/after each
    // the trading call: first update at/after 10:30 AM EST, with Kalshi's price for that bracket then
    if (k === "today" && HM >= 630 && HM < 900 && !e.call1030) {
      const b = (f.brackets || []).find((x) => x.label === f.call);
      e.call1030 = { ...snap, p: b?.model_p != null ? Math.round(b.model_p * 100) : null, mkt: b?.mid != null ? Math.round(b.mid * 100) : null };
    }
    // every time the call changes: when, and what Kalshi was charging for the new bracket
    if (f.call) {
      const lastC = e.changes?.at(-1)?.call;
      if (lastC !== f.call) {
        const b = (f.brackets || []).find((x) => x.label === f.call);
        (e.changes ||= []).push({ at: snap.at, call: f.call, p: b?.model_p != null ? Math.round(b.model_p * 100) : null, mkt: b?.mid != null ? Math.round(b.mid * 100) : null });
        if (e.changes.length > 15) e.changes = e.changes.slice(-15);
      }
    }
    // freeze the "last" call at the usual peak (evening runs only see the cooling)
    if (k !== "today" || H < 16 || !e.latest) e.latest = snap;
    // nowcast checkpoints for the daily review
    if (k === "today") for (const ch of [10, 12, 14]) if (H >= ch && H < ch + 2 && !e.nowcast?.[ch])
      (e.nowcast ||= {})[ch] = { at: fc.generatedTxt, call: f.call, mean: f.mean, expected: f.expected, floor: f.floor, rate: f.pacing?.rate ?? null };
  }
}
const cli = fc?.cli || (await fetchCliHighs().catch(() => ({})));
for (const [d, e] of Object.entries(log)) if (cli[d]) e.actual = cli[d].high;
log = Object.fromEntries(Object.entries(log).sort().slice(-60));
writeFileSync("forecast_log.json", JSON.stringify(log, null, 1));

// ---- daily review: once the CLI high is in (preliminary ~5 PM, final after midnight) ----
let reviews = {};
try { reviews = JSON.parse(readFileSync("forecast_reviews.json", "utf8")); } catch { /* new */ }
const recent = Object.keys(cli).filter((d) => d <= todayS).sort().slice(-4);
for (const d of recent) {
  const actual = cli[d].high, old = reviews[d];
  if (d === todayS && now.getUTCHours() < 17) continue;            // not before the day is done
  if (old && old.actual === actual && (old.final || d === todayS)) continue; // prelim once, then once more as final
  try {
    const r = await reviewDay(d, { actual, logEntry: log[d], wethr: wethr && !wethr.error ? wethr : null });
    r.final = d < todayS; reviews[d] = r; console.log("reviewed", d, "|", r.tags.join(", "));
  } catch (e) { console.log("review failed", d, e.message); }
}
reviews = Object.fromEntries(Object.entries(reviews).sort().slice(-90));
writeFileSync("forecast_reviews.json", JSON.stringify(reviews, null, 1));
