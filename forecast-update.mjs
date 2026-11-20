// Scheduled updater (GitHub Action: .github/workflows/forecast.yml).
// 1. Pulls Kalshi odds for today + tomorrow -> kalshi.json (the browser can't call Kalshi: no CORS).
// 2. Runs the full engine server-side -> forecast.json (fallback snapshot for the page).
// 3. Keeps forecast_log.json: first / morning / latest call per day + the CLI actual.
import { writeFileSync, readFileSync } from "node:fs";
import { fetchKalshiDirect, runForecast, estNow, fetchCliHighs } from "./forecast-engine.js";

const now = estNow();
const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
const tomorrow = new Date(today.getTime() + 86400e3);
const kalshi = { fetched_utc: new Date().toISOString() };
for (const [k, d] of [["today", today], ["tomorrow", tomorrow]]) {
  try { kalshi[k] = await fetchKalshiDirect(d); } catch (e) { kalshi[k] = { error: e.message, brackets: [] }; }
}
writeFileSync("kalshi.json", JSON.stringify(kalshi, null, 1));
console.log("kalshi:", kalshi.today.peak, "|", kalshi.tomorrow.peak);

let fc = null;
try {
  fc = await runForecast({ inBrowser: false, kalshi });
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
    const snap = { at: `${now.toISOString().slice(5, 10)} ${fc.generatedTxt}`, point: f.point, call: f.call, mean: f.mean, kalshi_peak: f.kalshi.peak };
    e.first ||= snap;
    if (k === "today" && now.getUTCHours() < 11) e.morning = snap;
    e.latest = snap;
  }
}
const cli = fc?.cli || (await fetchCliHighs().catch(() => ({})));
for (const [d, e] of Object.entries(log)) if (cli[d]) e.actual = cli[d].high;
log = Object.fromEntries(Object.entries(log).sort().slice(-60));
writeFileSync("forecast_log.json", JSON.stringify(log, null, 1));
