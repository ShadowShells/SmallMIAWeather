// Daily review: once the CLI high is in, look back at the day and record what made it.
// Writes into forecast_reviews.json (keyed by date). Used by forecast-update.mjs.
import { STATION, MODELS, skyState, compass } from "./forecast-engine.js";

const r1 = (x) => Math.round(x * 10) / 10;
const sectorOf = (wd) => (wd == null ? "calm" : (wd >= 290 || wd < 20) ? "N/NW" : wd < 150 ? "E/onshore" : wd < 240 ? "S/SW" : "W/land");
const hm = (h, m) => `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
async function get(url, json = true) {
  for (let i = 0; ; i++) {
    const r = await fetch(url);
    if (r.ok) return json ? r.json() : r.text();
    if (r.status !== 429 || i >= 3) throw new Error(`${url.split("?")[0]} HTTP ${r.status}`);
    await new Promise((res) => setTimeout(res, 5000 * (i + 1)));
  }
}

/** hourly obs for one CLI day (local standard time) */
async function dayObs(date) {
  const [y, m, d] = date.split("-").map(Number), nx = new Date(Date.UTC(y, m - 1, d + 1));
  const q = `station=${STATION.iemId}&data=tmpf&data=dwpf&data=drct&data=sknt&data=gust&data=skyc1&data=skyc2&data=skyc3&data=skyl1&data=skyl2&data=skyl3&data=wxcodes&data=p01i` +
    `&year1=${y}&month1=${m}&day1=${d}&year2=${nx.getUTCFullYear()}&month2=${nx.getUTCMonth() + 1}&day2=${nx.getUTCDate()}&tz=Etc/GMT%2B5&format=onlycomma&latlon=no&missing=empty&trace=0.0001&report_type=3&report_type=4`;
  const csv = await get("https://mesonet.agron.iastate.edu/cgi-bin/request/asos.py?" + q, false);
  const L = csv.trim().split("\n"), H = L[0].split(","), ix = (k) => H.indexOf(k), num = (x) => (x === "" || x == null ? null : parseFloat(x));
  return L.slice(1).map((ln) => ln.split(",")).filter((c) => c[1].startsWith(date)).map((c) => ({
    h: +c[1].slice(11, 13), m: +c[1].slice(14, 16), T: num(c[ix("tmpf")]), Td: num(c[ix("dwpf")]), wd: num(c[ix("drct")]), ws: num(c[ix("sknt")]), g: num(c[ix("gust")]),
    wx: c[ix("wxcodes")] || "", rain: num(c[ix("p01i")]) || 0,
    sky: skyState([c[ix("skyc1")], c[ix("skyc2")], c[ix("skyc3")]], [num(c[ix("skyl1")]), num(c[ix("skyl2")]), num(c[ix("skyl3")])], c[ix("wxcodes")]),
  })).filter((o) => o.T != null);
}

/** each model's same-day and day-ahead max for that CLI day (Open-Meteo previous-runs) */
async function modelMaxes(date) {
  const q = new URLSearchParams({ latitude: STATION.lat, longitude: STATION.lon, timezone: "Etc/GMT+5", start_date: date, end_date: date,
    models: Object.keys(MODELS).join(","), hourly: "temperature_2m,temperature_2m_previous_day1", temperature_unit: "fahrenheit" });
  const j = await get("https://previous-runs-api.open-meteo.com/v1/forecast?" + q), h = j.hourly, out = {};
  const mx = (a) => { const v = (a || []).filter((x) => x != null); return v.length ? r1(Math.max(...v)) : null; };
  for (const m of Object.keys(MODELS)) out[m] = { day0: mx(h[`temperature_2m_${m}`]), day1: mx(h[`temperature_2m_previous_day1_${m}`]) };
  return out;
}

export async function reviewDay(date, { actual, logEntry, wethr }) {
  const obs = await dayObs(date);
  if (obs.length < 12) throw new Error(`only ${obs.length} obs for ${date}`);
  let models = {}; try { models = await modelMaxes(date); } catch (e) { models = { error: e.message }; }

  // when + how the high was set
  const maxHourly = Math.max(...obs.map((o) => o.T)), pk = obs.find((o) => o.T === maxHourly);
  const spike = Math.round(actual - Math.round(maxHourly));
  const peakTxt = wethr?.date === date && wethr.time ? wethr.time : hm(pk.h, pk.m);
  const peakH = wethr?.date === date && wethr.time ? (() => { const [t, ap] = wethr.time.split(" "); const [hh, mm] = t.split(":").map(Number); return (hh % 12) + (ap === "PM" ? 12 : 0) + mm / 60; })() : pk.h + pk.m / 60;

  // conditions
  const win = (a, b) => obs.filter((o) => o.h >= a && o.h < b);
  let u = 0, v = 0; for (const o of win(10, 17)) if (o.ws > 0 && o.wd != null) { u += o.ws * Math.sin(o.wd * Math.PI / 180); v += o.ws * Math.cos(o.wd * Math.PI / 180); }
  const wdir = u || v ? Math.round((Math.atan2(u, v) * 180 / Math.PI + 360) % 360) : null, wspd = r1(Math.hypot(u, v) / Math.max(1, win(10, 17).length));
  const sector = sectorOf(wdir);
  const frac = (a, b) => { const w = win(a, b); return w.length ? w.filter((o) => o.sky === "cloudy/wet").length / w.length : 0; };
  const cloudAM = frac(8, 12), cloudPM = frac(12, 17);
  const dewAt = (h) => { const o = obs.filter((x) => x.h <= h && x.Td != null).at(-1); return o ? o.Td : null; };
  const dew8 = dewAt(8), dew13 = dewAt(13), dewChg = dew8 != null && dew13 != null ? r1(dew13 - dew8) : null;
  const rainDay = r1(obs.reduce((s, o) => s + (o.rain || 0), 0) * 100) / 100;
  const wetPM = win(11, 17).filter((o) => /RA|DZ|TS|SH/.test(o.wx));
  let drop = 0; const pm = win(11, 18);
  for (let i = 1; i < pm.length; i++) drop = Math.max(drop, pm[i - 1].T - pm[i].T);
  const gust = Math.max(0, ...win(9, 18).map((o) => o.g || 0));

  // tags: what made the day
  const tags = [];
  tags.push({ "W/land": "W land breeze", "E/onshore": "onshore E flow", "S/SW": "S/SW flow", "N/NW": "N/NW flow", calm: "calm/variable" }[sector]);
  if (cloudAM >= 0.5 && cloudPM < 0.35) tags.push("morning clouds cleared");
  else if (cloudPM >= 0.5) tags.push("afternoon cloud cap");
  else if (cloudAM < 0.35 && cloudPM < 0.35) tags.push("sunny");
  if (dewChg != null && dewChg <= -3) tags.push("drying mid-day");
  if (dewChg != null && dewChg >= 3) tags.push("moistening");
  if (wetPM.length && drop >= 3) tags.push("shower cooled it");
  else if (wetPM.length) tags.push("showers around");
  if (peakH >= 14.5) tags.push("late peak");
  if (peakH < 11.5) tags.push("early peak");
  if (spike >= 1) tags.push(`1-min spike +${spike}`);
  if (gust >= 18) tags.push("gusty");

  // who was right: calls, market, NWS, models
  const L = logEntry || {}, err = (x) => (x == null ? null : r1(x - actual));
  const sources = [];
  const add = (name, val, kind) => { if (val != null) sources.push({ name, val: r1(val), miss: err(val), kind }); };
  add("Page · night before", L.first?.mean, "page"); add("Page · morning", L.morning?.mean, "page");
  for (const h of [10, 12, 14]) add(`Page · ${h > 12 ? h - 12 : h}${h >= 12 ? " PM" : " AM"} nowcast`, L.nowcast?.[h]?.expected ?? L.nowcast?.[h]?.mean, "page");
  add("NWS", L.morning?.nws ?? L.first?.nws, "other"); add("Similar days", L.morning?.analog ?? L.first?.analog, "other");
  const kp = (L.morning || L.first)?.kalshi_implied; add("Kalshi (morning)", kp, "other");
  for (const [m, lab] of Object.entries(MODELS)) { const x = models[m]; if (x?.day1 != null) add(`${lab} · day before`, x.day1, "model"); if (x?.day0 != null) add(`${lab} · same day`, x.day0, "model"); }
  const bestModels = sources.filter((s) => s.kind === "model" && s.name.includes("same day")).sort((a, b) => Math.abs(a.miss) - Math.abs(b.miss));
  const page = L.morning || L.first;
  const callHit = page?.call && (() => { const m = page.call.match(/(\d+)\D+(\d+)/); if (m) return actual >= +m[1] && actual <= +m[2]; const n = +(page.call.match(/\d+/) || [])[0]; return /below/.test(page.call) ? actual <= n : /above/.test(page.call) ? actual >= n : null; })();

  // summary
  const bits = [];
  bits.push(`High ${actual}°F at ${peakTxt}${spike >= 1 ? ` (1-minute data, ${spike}° above the best hourly reading)` : ""}.`);
  bits.push(`${tags[0]}${wdir != null ? ` (${compass(wdir)} ${wspd} kt)` : ""}; ${tags.slice(1).filter((t) => !/spike/.test(t)).join(", ") || "no notable events"}.`);
  if (dewChg != null && Math.abs(dewChg) >= 3) bits.push(`Dewpoint ${dew8}→${dew13}°F by 1 PM.`);
  if (page?.call) bits.push(`Morning call ${page.call} ${callHit ? "hit" : "missed"} (mean ${page.mean}, off ${err(page.mean) > 0 ? "+" : ""}${err(page.mean)}).`);
  if (bestModels.length) {
    const w = bestModels.filter((s) => Math.abs(s.miss) <= 1).map((s) => s.name.split(" ·")[0]), c = bestModels.filter((s) => s.miss <= -2).map((s) => s.name.split(" ·")[0]), hh = bestModels.filter((s) => s.miss >= 2).map((s) => s.name.split(" ·")[0]);
    if (w.length) bits.push(`Closest: ${w.join(", ")}.`);
    if (c.length) bits.push(`Too cool: ${c.join(", ")}.`);
    if (hh.length) bits.push(`Too warm: ${hh.join(", ")}.`);
  }

  return { date, actual, reviewed: new Date().toISOString(), peak: peakTxt, peakH: r1(peakH), maxHourly: Math.round(maxHourly), spike, sector, wind: wdir != null ? `${compass(wdir)} ${wspd} kt` : "calm",
    cloudAM: Math.round(cloudAM * 100), cloudPM: Math.round(cloudPM * 100), dew8, dew13, dewChg, rain: rainDay, gust, tags, summary: bits.join(" "),
    callHit, sources, models };
}
