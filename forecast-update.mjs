// Scheduled updater (GitHub Action: .github/workflows/forecast.yml).
// 1. Pulls Kalshi odds for today + tomorrow -> kalshi.json (the browser can't call Kalshi: no CORS).
// 2. Runs the full engine server-side -> forecast.json (fallback snapshot for the page).
// 3. Keeps forecast_log.json: first / morning / latest call per day + the CLI actual.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fetchKalshiDirect, runForecast, estNow, fetchCliHighs, STATION } from "./forecast-engine.js";
import { train } from "./forecast-train.mjs";

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
  fc = await runForecast({ inBrowser: false, kalshi, learned, wethr: wethr && !wethr.error ? wethr : null });
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
    const snap = { at: `${now.toISOString().slice(5, 10)} ${fc.generatedTxt}`, point: f.point, call: f.call, mean: f.mean, meanRaw: f.meanRaw, sector: f.regime?.sector, kalshi_peak: f.kalshi.peak };
    e.first ||= snap;
    if (k === "today" && now.getUTCHours() < 11) e.morning = snap;
    e.latest = snap;
  }
}
const cli = fc?.cli || (await fetchCliHighs().catch(() => ({})));
for (const [d, e] of Object.entries(log)) if (cli[d]) e.actual = cli[d].high;
log = Object.fromEntries(Object.entries(log).sort().slice(-60));
writeFileSync("forecast_log.json", JSON.stringify(log, null, 1));
