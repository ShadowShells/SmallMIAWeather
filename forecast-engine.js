/* ============================================================
   KMIA DAILY-HIGH FORECAST ENGINE  (shared by forecast.html and
   the scheduled GitHub Action, forecast-update.mjs)
   ------------------------------------------------------------
   Automates the hand method:
     1. Kalshi odds   -> distribution, peak bracket, window, implied high
     2. Models        -> HRRR, GFS, NBM, ECMWF, ICON, GEM, UKMO (Open-Meteo)
                         + NWS. Each model's day-ahead forecast for the last
                         7 CLI days is scored vs the NWS CLI high -> bias,
                         error, weight.
     3. Observations  -> KMIA METARs: high so far (T-groups + 6-h max groups),
                         latest temp/wind/sky, pacing vs each model.
     4. Regime        -> wind sector, CAPE/rain (storm risk), low cloud,
                         850 hPa temp (the numbers read off soundings/maps).
     5. Analogs       -> past seasons (IEM ASOS archive) with the same wind
                         sector, rain flag and dewpoint.
     6. Blend         -> bias-corrected weighted model mean (+ pacing, NWS,
                         analogs), floored at the observed high -> bracket
                         probabilities vs Kalshi.
   Tunables are in CFG.
   ============================================================ */

export const STATION = {
  icao: "KMIA", name: "Miami Intl", lat: 25.7906, lon: -80.3164,
  kalshi: "KXHIGHMIA", iemNetwork: "FL_ASOS", iemId: "MIA", nwsGrid: "MFL/105,51",
  utcOffset: -5, // CLI day = local standard time, all year
};

export const MODELS = {
  ncep_hrrr_conus: "HRRR", gfs_global: "GFS", ncep_nbm_conus: "NBM",
  ecmwf_ifs025: "ECMWF", icon_seamless: "ICON", gem_seamless: "GEM", ukmo_seamless: "UKMO",
};

export const CFG = {
  scoreDays: 7,          // CLI days used to score models
  biasShrink: 0.75,      // use 75 % of the measured mean bias
  biasClamp: 6,
  nwsWeight: 0.15,       // share of the blend given to the NWS point high
  analogWeightToday: 0.05,
  analogWeightTomorrow: 0.12,
  sdTomorrow: 1.6,       // base spread (°F) for next-day forecast
  peakHour: 15.5,        // spread shrinks as this local hour approaches
};

const HOURLY = ["temperature_2m", "temperature_2m_previous_day1", "dew_point_2m", "cloud_cover_low",
  "cloud_cover", "wind_speed_10m", "wind_direction_10m", "cape", "precipitation", "temperature_850hPa"];

/* ---------------- time helpers (fixed EST clock) ---------------- */
const OFF = STATION.utcOffset * 3600e3;
export const estNow = () => new Date(Date.now() + OFF);           // fields read with getUTC*
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400e3);
const dayStart = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const hm = (d) => { let h = d.getUTCHours(), m = d.getUTCMinutes(); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${String(m).padStart(2, "0")} ${ap}`; };
const hh = (d) => { let h = d.getUTCHours(); const ap = h >= 12 ? "PM" : "AM"; return `${h % 12 || 12} ${ap}`; };
const c2f = (c) => c * 9 / 5 + 32;
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const median = (a) => { const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };
const quant = (a, q) => { const s = [...a].sort((x, y) => x - y); const i = (s.length - 1) * q, lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
const wmean = (v, w) => v.reduce((s, x, i) => s + x * w[i], 0) / w.reduce((s, x) => s + x, 0);
const r1 = (x) => Math.round(x * 10) / 10;
function erf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; }
const ncdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));
function vecDir(dirs, spds) {
  if (!dirs.length) return null;
  let u = 0, v = 0;
  dirs.forEach((d, i) => { const s = spds ? spds[i] : 1; u += s * Math.sin(d * Math.PI / 180); v += s * Math.cos(d * Math.PI / 180); });
  return (Math.atan2(u, v) * 180 / Math.PI + 360) % 360;
}
const angDiff = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
export function compass(d) {
  if (d == null) return "—";
  const p = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return p[Math.floor((d + 11.25) / 22.5) % 16];
}
const kalshiCode = (d) => `${String(d.getUTCFullYear()).slice(2)}${["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"][d.getUTCMonth()]}${String(d.getUTCDate()).padStart(2, "0")}`;
export const kalshiEvent = (d) => `${STATION.kalshi}-${kalshiCode(d)}`;

/* ---------------- fetchers ---------------- */
async function getJSON(url, tries = 2) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) { last = e; await new Promise((s) => setTimeout(s, 1500 * (i + 1))); }
  }
  throw new Error(`${url.split("?")[0]}: ${last && last.message}`);
}
async function getText(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`${url.split("?")[0]}: HTTP ${r.status}`);
  return r.text();
}

export function parseKalshi(d, event) {
  const out = [];
  for (const m of d.markets || []) {
    let lo, hi;
    if (m.strike_type === "between") { lo = m.floor_strike; hi = m.cap_strike; }
    else if (m.strike_type === "less") { lo = null; hi = m.cap_strike - 1; }
    else if (m.strike_type === "greater") { lo = m.floor_strike + 1; hi = null; }
    else continue;
    const f = (k) => (m[k] == null || m[k] === "" ? null : parseFloat(m[k]));
    const bid = f("yes_bid_dollars"), ask = f("yes_ask_dollars"), last = f("last_price_dollars");
    const mid = bid != null && ask != null && ask > 0 ? (bid + ask) / 2 : last;
    out.push({ label: m.yes_sub_title, lo, hi, bid, ask, last, mid, volume: m.volume });
  }
  out.sort((a, b) => (a.lo ?? -999) - (b.lo ?? -999));
  const tot = out.reduce((s, b) => s + (b.mid || 0), 0);
  const res = { event, brackets: out };
  if (tot < 0.2) { // market listed but not trading yet
    out.forEach((b) => (b.p = null));
    res.noMarket = true;
    return res;
  }
  out.forEach((b) => (b.p = (b.mid || 0) / tot));
  if (out.length) {
    const peak = out.reduce((a, b) => (b.p > a.p ? b : a));
    res.peak = peak.label;
    let i = out.indexOf(peak), a = i, b = i, cov = peak.p;
    while (cov < 0.85 && (a > 0 || b < out.length - 1)) {
      const L = a > 0 ? out[a - 1].p : -1, R = b < out.length - 1 ? out[b + 1].p : -1;
      if (R >= L) { b++; cov += R; } else { a--; cov += L; }
    }
    res.window = { from: out[a].label, to: out[b].label, cover: cov };
    const cents = out.map((x) => x.lo != null && x.hi != null ? (x.lo + x.hi) / 2 : x.lo == null ? x.hi - 0.5 : x.lo + 0.5);
    res.implied = r1(wmean(cents, out.map((x) => x.p)));
  }
  return res;
}

export async function fetchKalshiDirect(day) {
  const ev = kalshiEvent(day);
  const d = await getJSON(`https://api.elections.kalshi.com/trade-api/v2/markets?event_ticker=${ev}`);
  return parseKalshi(d, ev);
}

export async function fetchModels() {
  const q = new URLSearchParams({
    latitude: STATION.lat, longitude: STATION.lon, timezone: "Etc/GMT+5", past_days: 8, forecast_days: 3,
    models: Object.keys(MODELS).join(","), hourly: HOURLY.join(","),
    temperature_unit: "fahrenheit", wind_speed_unit: "kn", precipitation_unit: "inch",
  });
  // previous-runs API serves the current run AND each model's day-ahead run (for scoring);
  // fall back to the main API (no scoring) if it is unavailable
  let j;
  try { j = await getJSON("https://previous-runs-api.open-meteo.com/v1/forecast?" + q); }
  catch (e) {
    q.set("hourly", HOURLY.filter((v) => !v.includes("previous")).join(","));
    j = await getJSON("https://api.open-meteo.com/v1/forecast?" + q);
  }
  const h = j.hourly;
  const times = h.time.map((t) => new Date(t + ":00Z")); // already EST wall clock
  const series = {};
  for (const m of Object.keys(MODELS)) {
    series[m] = {};
    for (const v of HOURLY) series[m][v] = h[`${v}_${m}`] || null;
  }
  return { times, series };
}

export async function fetchCliHighs() {
  const yr = estNow().getUTCFullYear(), out = {};
  for (const y of [yr - 1, yr]) {
    try {
      const d = await getJSON(`https://mesonet.agron.iastate.edu/json/cli.py?station=${STATION.icao}&year=${y}`);
      for (const r of d.results || []) if (typeof r.high === "number") out[r.valid] = { high: r.high, low: r.low, high_time: r.high_time, precip: r.precip };
    } catch (e) { /* keep going */ }
  }
  return out;
}

function parseRaw(raw) {
  const rmk = raw.includes("RMK") ? raw.split("RMK")[1] : "";
  const tg = raw.match(/\bT([01])(\d{3})([01])(\d{3})\b/);
  const mx = rmk.match(/(?:^|\s)1([01])(\d{3})(?=\s|$)/);
  return {
    tC: tg ? (tg[1] === "1" ? -1 : 1) * +tg[2] / 10 : null,
    max6C: mx ? (mx[1] === "1" ? -1 : 1) * +mx[2] / 10 : null,
  };
}

/** METARs: Node uses aviationweather.gov; the browser uses api.weather.gov (CORS-enabled). */
export async function fetchObs(inBrowser) {
  const obs = [];
  if (!inBrowser) {
    const d = await getJSON(`https://aviationweather.gov/api/data/metar?ids=${STATION.icao}&hours=30&format=json`);
    for (const m of d) {
      const p = parseRaw(m.rawOb || "");
      const tC = p.tC ?? m.temp;
      obs.push({ t: new Date(m.obsTime * 1000 + OFF), tC, max6C: p.max6C, dewC: m.dewp, wdir: m.wdir, wspd: m.wspd, wgst: m.wgst,
        wx: m.wxString, sky: (m.clouds || []).map((c) => `${c.cover}${String(Math.round(c.base / 100)).padStart(3, "0")}`).join(" ") || "CLR", raw: m.rawOb });
    }
  } else {
    const d = await getJSON(`https://api.weather.gov/stations/${STATION.icao}/observations?limit=60`);
    for (const f of d.features) {
      const p = f.properties, raw = p.rawMessage || "";
      const pr = parseRaw(raw);
      const tC = pr.tC ?? p.temperature?.value;
      if (tC == null) continue;
      const kmh = p.windSpeed?.value, g = p.windGust?.value;
      obs.push({ t: new Date(Date.parse(p.timestamp) + OFF), tC, max6C: pr.max6C, dewC: p.dewpoint?.value,
        wdir: p.windDirection?.value ?? "VRB", wspd: kmh != null ? Math.round(kmh / 1.852) : null, wgst: g != null ? Math.round(g / 1.852) : null,
        wx: p.textDescription, sky: (p.cloudLayers || []).map((c) => `${c.amount}${c.base?.value != null ? String(Math.round(c.base.value * 3.281 / 100)).padStart(3, "0") : ""}`).join(" ") || "CLR",
        raw, fromMetar: !!pr.tC });
    }
  }
  obs.sort((a, b) => a.t - b.t);
  return obs;
}

export async function fetchNws() {
  const out = {};
  try {
    const d = await getJSON(`https://api.weather.gov/gridpoints/${STATION.nwsGrid}/forecast`);
    for (const p of d.properties.periods) if (p.isDaytime) {
      const k = ymd(new Date(Date.parse(p.startTime) + OFF));
      (out[k] ||= {}).high = p.temperature; out[k].text = p.shortForecast;
    }
  } catch (e) { /* optional */ }
  try {
    const d = await getJSON(`https://api.weather.gov/gridpoints/${STATION.nwsGrid}/forecast/hourly`);
    for (const p of d.properties.periods) {
      const t = new Date(Date.parse(p.startTime) + OFF), k = ymd(t), e = (out[k] ||= {});
      if (p.temperature >= (e.hourlyMax ?? -999)) { e.hourlyMax = p.temperature; e.hourlyMaxTime = hh(t); }
      const pop = p.probabilityOfPrecipitation?.value || 0;
      if (t.getUTCHours() >= 10 && t.getUTCHours() <= 16) e.popMid = Math.max(e.popMid || 0, pop);
    }
  } catch (e) { /* optional */ }
  return out;
}

export async function fetchHistory(target) {
  const q = new URLSearchParams([["network", STATION.iemNetwork], ["stations", STATION.iemId],
    ["year1", 2006], ["month1", 1], ["day1", 1], ["year2", target.getUTCFullYear() - 1], ["month2", 12], ["day2", 31],
    ["var", "max_temp_f"], ["var", "max_dewpoint_f"], ["var", "precip_in"], ["var", "avg_wind_drct"], ["var", "avg_wind_speed_kts"],
    ["format", "csv"], ["na", "blank"]]);
  const txt = await getText("https://mesonet.agron.iastate.edu/cgi-bin/request/daily.py?" + q);
  const [hdr, ...lines] = txt.trim().split("\n"); const H = hdr.split(",");
  const rows = [];
  for (const ln of lines) {
    const r = Object.fromEntries(ln.split(",").map((v, i) => [H[i], v]));
    const hi = parseFloat(r.max_temp_f), dew = parseFloat(r.max_dewpoint_f), dir = parseFloat(r.avg_wind_drct);
    if ([hi, dew, dir].some(isNaN)) continue;
    rows.push({ day: r.day, hi, dew, pcp: parseFloat(r.precip_in) || 0, dir, spd: parseFloat(r.avg_wind_speed_kts) });
  }
  return rows;
}

/* ---------------- analysis ---------------- */
const cliIdx = (times, day) => { const a = dayStart(day).getTime(); return times.map((t, i) => [t.getTime(), i]).filter(([t]) => t >= a && t < a + 86400e3).map(([, i]) => i); };

export function scoreModels(times, series, cli, today) {
  const sc = {};
  for (const m of Object.keys(MODELS)) {
    const errs = [], pv = series[m].temperature_2m_previous_day1;
    for (let k = 1; k <= CFG.scoreDays && pv; k++) {
      const d = addDays(today, -k), act = cli[ymd(d)];
      if (!act) continue;
      const vals = cliIdx(times, d).map((i) => pv[i]).filter((v) => v != null);
      if (vals.length < 20) continue;
      const fc = Math.max(...vals);
      errs.push({ date: ymd(d), fc: r1(fc), act: act.high, err: r1(act.high - fc) });
    }
    if (errs.length >= 3) {
      const e = errs.map((x) => x.err), mb = mean(e);
      const sdev = mean(e.map((x) => Math.abs(x - mb))), mae = mean(e.map(Math.abs));
      sc[m] = { bias: r1(Math.max(-CFG.biasClamp, Math.min(CFG.biasClamp, CFG.biasShrink * mb))), mae: r1(Math.max(0.6, 0.6 * sdev + 0.4 * mae)), n: errs.length, days: errs };
    } else sc[m] = { bias: 0, mae: 2.5, n: errs.length, days: errs };
  }
  return sc;
}

export function regime(times, series, day) {
  const idx = cliIdx(times, day).filter((i) => times[i].getUTCHours() >= 10 && times[i].getUTCHours() <= 16);
  const pick = (v) => { const out = []; for (const m in MODELS) { const s = series[m][v]; if (s) for (const i of idx) if (s[i] != null) out.push(s[i]); } return out; };
  const pairs = []; for (const m in MODELS) { const d = series[m].wind_direction_10m, s = series[m].wind_speed_10m; if (d && s) for (const i of idx) if (d[i] != null && s[i] != null) pairs.push([d[i], s[i]]); }
  const wd = vecDir(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
  const capes = pick("cape"), lowc = pick("cloud_cover_low"), tot = pick("cloud_cover"), t850 = pick("temperature_850hPa"), dews = pick("dew_point_2m");
  const all = cliIdx(times, day), pcp = [];
  for (const m in MODELS) { const v = series[m].precipitation; if (v) { const s = all.map((i) => v[i]).filter((x) => x != null); if (s.length > 18) pcp.push(s.reduce((a, b) => a + b, 0)); } }
  const rain = pcp.length ? mean(pcp) : 0, cape = capes.length > 10 ? quant(capes, 0.9) : capes.length ? Math.max(...capes) : 0;
  const low = lowc.length ? mean(lowc) : null;
  const r = { windDir: wd == null ? null : Math.round(wd), windTxt: compass(wd), windKt: pairs.length ? r1(mean(pairs.map((p) => p[1]))) : null,
    rainIn: Math.round(rain * 100) / 100, cape90: Math.round(cape), lowCloud: low == null ? null : Math.round(low),
    totalCloud: tot.length ? Math.round(mean(tot)) : null, t850F: t850.length ? r1(mean(t850)) : null, dewMax: dews.length ? r1(Math.max(...dews)) : null, notes: [] };
  if (wd != null) {
    if (wd >= 290 || wd < 20) { r.sector = "N/NW"; r.notes.push("N/NW post-frontal flow: cool, dry advection. KMIA tends to run under the warm models."); }
    else if (wd < 150) { r.sector = "E/onshore"; r.notes.push("Onshore E flow off the Atlantic moderates the high. Gusts mix city-heated air down, so 1-minute bursts can print above the hourly METARs."); }
    else if (wd < 240) { r.sector = "S/SW"; r.notes.push("S/SW flow: warm and humid; cumulus and storm timing decide it."); }
    else { r.sector = "W/land"; r.notes.push("W land breeze across the Everglades: the hot pattern, no ocean cap."); }
  }
  if (cape >= 1000 && rain >= 0.25) { r.storm = "high"; r.notes.push(`Storm risk high (CAPE ~${Math.round(cape)} J/kg, ~${rain.toFixed(2)}" model rain): an early storm or outflow can end the rise.`); }
  else if (cape >= 500 || rain >= 0.10) { r.storm = "moderate"; r.notes.push(`Scattered showers possible (CAPE ~${Math.round(cape)}, ~${rain.toFixed(2)}" rain): timing vs the 11 AM–2 PM peak matters.`); }
  else r.storm = "low";
  if (low != null && low >= 60) r.notes.push(`Low cloud ~${Math.round(low)}% at midday: broken cumulus trims ~1–2 °F.`);
  return r;
}

export function analogs(rows, target, reg) {
  if (!rows?.length || reg.windDir == null) return null;
  const doy = (s) => { const d = new Date(s + "T00:00:00Z"); return Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400e3); };
  const t = doy(ymd(target)), c = [];
  for (const r of rows) {
    const dd = Math.abs(doy(r.day) - t); if (Math.min(dd, 365 - dd) > 21) continue;
    let s = angDiff(r.dir, reg.windDir) / 45;
    if (reg.dewMax != null) s += Math.abs(r.dew - reg.dewMax) / 4;
    if ((r.pcp >= 0.1) !== (reg.rainIn >= 0.1)) s += 1;
    c.push([s, r]);
  }
  c.sort((a, b) => a[0] - b[0]);
  const best = c.slice(0, 30).map((x) => x[1]);
  if (best.length < 10) return null;
  const hs = best.map((r) => r.hi);
  return { n: best.length, median: median(hs), p10: quant(hs, 0.1), p90: quant(hs, 0.9),
    top: best.slice(0, 8).map((r) => ({ date: r.day, high: r.hi, dir: compass(r.dir), rain: r.pcp, dew: r.dew })) };
}

export function obsToday(obs, day) {
  const a = dayStart(day).getTime();
  const td = obs.filter((o) => o.t.getTime() >= a && o.t.getTime() < a + 86400e3 && o.tC != null);
  if (!td.length) return null;
  let mx = -999, src = "", hiT = null;
  // whole-°C 5-min readings only prove the low end of their range (23 °C -> at least 72.5 °F)
  for (const o of td) { const f = o.floorF ?? (o.fromMetar === false ? r1(c2f(o.tC - 0.5)) : r1(c2f(o.tC))); if (f > mx) { mx = f; hiT = o.t; src = o.src || (o.fromMetar === false ? "5-min obs" : "METAR"); } }
  for (const o of td) if (o.max6C != null && o.t.getUTCHours() >= 6) { const f = r1(c2f(o.max6C)); if (f > mx) { mx = f; hiT = o.t; src = `6-h max group (${hm(o.t)})`; } }
  const last = td[td.length - 1];
  const whole = last.fromMetar === false;
  // hourly-METAR-only high (what the history tables are measured from; excludes 5-min/1-min readings)
  const mets = td.filter((o) => o.fromMetar !== false && !o.src);
  const maxMetar = mets.length ? Math.max(...mets.map((o) => Math.round(c2f(o.tC)))) : null;
  // smoothed "now": a fresh METAR T-group if there is one, else the mean of the last 20 min of
  // whole-°C 5-min readings (a single 5-min reading can be off by up to 0.9 °F)
  const lm = mets[mets.length - 1], tl = last.t.getTime();
  const rec = td.filter((o) => o.t.getTime() >= tl - 20 * 60e3);
  let nowFit = lm && tl - lm.t.getTime() <= 30 * 60e3 ? c2f(lm.tC) : rec.reduce((s2, o) => s2 + c2f(o.tC), 0) / rec.length;
  // a newer whole-°C reading bounds where the temperature is now: clamp into its range
  if (last.fromMetar === false && (!lm || last.t > lm.t)) nowFit = Math.min(c2f(last.tC + 0.5) - 0.05, Math.max(c2f(last.tC - 0.5), nowFit));
  nowFit = r1(nowFit);
  return Object.defineProperty({ maxSoFar: mx, maxMetar, nowFit, maxSrc: src, maxTime: hiT ? hm(hiT) : null, nowF: r1(c2f(last.tC)), nowRange: whole ? `${Math.round(c2f(last.tC - 0.5))}–${Math.round(c2f(last.tC + 0.5) - 0.01)}` : null,
    nowSrc: last.src || (whole ? "5-min" : "METAR"), nowT: last.t, nowTime: hm(last.t) + " EST",
    dewF: last.dewC != null ? Math.round(c2f(last.dewC)) : null,
    wind: `${last.wdir ?? "—"}${last.wspd != null ? " @ " + last.wspd : ""}${last.wgst ? "G" + last.wgst : ""} kt`, wx: last.wx || "", sky: last.sky, raw: last.raw,
    series: td.map((o) => ({ h: o.t.getUTCHours() + o.t.getUTCMinutes() / 60, f: r1(c2f(o.tC)) })) }, "_td", { value: td, enumerable: false });
}

/* ---------------- learning (forecast_learned.json from forecast-train.mjs) ---------------- */
export const trendBucket = (d) => d == null ? null : d <= 0 ? "≤0" : d === 1 ? "+1" : d === 2 ? "+2" : "≥3";
/** cloudy/wet = a BKN/OVC/VV layer at or below 5,000 ft, or rain/drizzle/thunder reported */
export const skyState = (covers, basesFt, wx) => {
  if (/RA|DZ|TS|SH|rain|drizzle|thunder|shower/i.test(wx || "")) return "cloudy/wet";
  for (let i = 0; i < covers.length; i++) if (/BKN|OVC|VV/.test(covers[i] || "") && basesFt[i] != null && basesFt[i] <= 5000) return "cloudy/wet";
  return "fair";
};

/** Nowcast: last-hour trend, current rate, sky/rain and gusts now -> historical distribution of
 *  the final high from here, plus the climb each bracket still needs before the usual peak hour. */
export function nowcast(learned, ob, sector, floor, brackets, hNow) {
  const td = ob?._td; if (!td?.length || !learned?.nowcast) return null;
  const last = td[td.length - 1], tNow = last.t.getTime(), F = (o) => c2f(o.tC);
  const h = Math.min(16, Math.max(7, last.t.getUTCHours()));
  // temp ~60 min ago and the regression rate over the last 60 min
  // last-hour trend from hourly METARs only (that's how the history table measured it)
  const mets = td.filter((o) => o.fromMetar !== false && !o.src), lm = mets[mets.length - 1];
  const pm = lm ? mets.filter((o) => Math.abs(o.t.getTime() - (lm.t.getTime() - 3600e3)) <= 25 * 60e3).sort((a, b) => Math.abs(a.t - (lm.t - 3600e3)) - Math.abs(b.t - (lm.t - 3600e3)))[0] : null;
  const prev = pm;
  const trend = lm && pm && tNow - lm.t.getTime() <= 75 * 60e3 ? Math.round(F(lm)) - Math.round(F(pm)) : null;
  // rate: least-squares slope over the last 75 min of every reading (5-min + METAR)
  const win = td.filter((o) => o.t.getTime() >= tNow - 75 * 60e3);
  let rate = null;
  if (win.length >= 3) {
    const xs = win.map((o) => (o.t.getTime() - tNow) / 3600e3), ys = win.map(F), mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
    const den = xs.reduce((s2, x) => s2 + (x - mx) ** 2, 0); if (den > 0) rate = r1(xs.reduce((s2, x, i) => s2 + (x - mx) * (ys[i] - my), 0) / den);
  }
  if (rate == null && lm && pm) rate = r1((F(lm) - F(pm)) / ((lm.t - pm.t) / 3600e3));
  // sky + weather from the latest ob that carries them (METARs; wethr's 5-min rows don't)
  const sk = [...td].reverse().find((o) => o.sky || o.raw);
  let sky = "fair", skyTxt = "—";
  if (sk) {
    const toks = (sk.sky || "").split(/\s+/).filter(Boolean), covers = toks.map((t) => t.replace(/\d+$/, "")), bases = toks.map((t) => { const m = t.match(/(\d{3})$/); return m ? +m[1] * 100 : null; });
    const wxs = `${sk.wx || ""} ${(sk.raw || "").split("RMK")[0].split(/\s+/).filter((w) => /^[-+]?(VC)?(TS|SH|RA|DZ)/.test(w)).join(" ")}`;
    sky = skyState(covers, bases, wxs); skyTxt = `${sk.sky || ""}${sk.wx ? " · " + sk.wx : ""}`.trim();
  }
  const gust = Math.max(0, ...td.filter((o) => o.t.getUTCHours() >= 9).map((o) => o.wgst || 0));
  const tb = trendBucket(trend), T = learned.nowcast[h] || {};
  let key = null, tab = null;
  for (const k of tb ? [`${tb}|${sky}`, `${tb}|*`, `*|${sky}`] : [`*|${sky}`]) if (T[k]) { key = k; tab = T[k]; break; }
  if (!tab) { tab = learned.pacing?.all?.[h]; key = "all"; } if (!tab) return null;
  // history is measured from the hourly-METAR high; the smoothed current temp stands in for the next METAR
  const base = Math.max(ob.maxMetar ?? -999, ob.nowFit != null ? Math.round(ob.nowFit) : -999, ob.maxMetar == null ? Math.floor(ob.maxSoFar + 0.5) : -999), fi = floor != null ? Math.floor(floor + 0.5) : -999, emp = {}; let et = 0;
  for (const [r, p] of Object.entries(tab.p)) { const k = base + +r; if (p > 0 && k >= fi) { emp[k] = (emp[k] || 0) + p; et += p; } }
  for (const k in emp) emp[k] /= et || 1;
  // aim for the late end of the usual peak window (90th pct of the hourly-high time for this wind)
  const pk = learned.peak?.[sector] || learned.peak?.all, peakBy = pk ? (pk.p90 ?? pk.p75 + 1) + 0.1 : 15;
  const left = peakBy - hNow, nowF = ob.nowFit ?? r1(F(last));
  const reach = (brackets || []).filter((b) => b.lo != null).map((b) => {
    const need = b.lo - 0.5, hist = Object.entries(emp).filter(([k]) => +k >= b.lo).reduce((s2, [, p]) => s2 + p, 0);
    if (fi >= b.lo) return { label: b.label, lo: b.lo, hist: 1, needRate: null, status: "reached" };
    if (left <= 0.25) return { label: b.label, lo: b.lo, hist, needRate: null, status: "past late peak" };
    const nr = r1((need - nowF) / left);
    const status = rate == null ? "—" : nr <= 0 ? "at line now" : rate >= nr ? "on pace" : rate >= 0.6 * nr ? "close" : "behind";
    return { label: b.label, lo: b.lo, hist, needRate: nr, status };
  });
  return { hour: h, trend, trendBucket: tb, rate, sky, skyTxt, gust, gusty: gust >= 18, key, n: tab.n, meanRise: tab.mean, base, emp,
    peakBy: r1(peakBy), hoursLeft: r1(Math.max(0, left)), nowF, reach, spikeGust: learned.spikeGust?.[gust >= 18 ? "gusty" : "calm"] || null };
}
/** Empirical pacing: given the hourly-METAR high so far at this hour and today's wind sector, the
 *  historical distribution of the final CLI high (whole °F). */
export function pacingDist(learned, sector, hour, maxSoFar) {
  const P = learned?.pacing; if (!P || maxSoFar == null) return null;
  const h = Math.min(17, Math.max(6, hour));
  const own = P[sector]?.[h], tab = own && own.n >= 60 ? own : P.all?.[h]; if (!tab) return null;
  const base = Math.floor(maxSoFar + 0.5), dist = {};
  for (const [r, p] of Object.entries(tab.p)) if (p > 0) dist[base + +r] = (dist[base + +r] || 0) + p;
  return { hour: h, sector: tab === own ? sector : "all", n: tab.n, base, meanRise: tab.mean, dist };
}

export function forecastDay({ day, now, times, series, scores, nws, kal, ob, ana, learned, reg, wethr }) {
  const idx = cliIdx(times, day), isToday = ymd(day) === ymd(now);
  const hourNow = new Date(Math.floor(now.getTime() / 3600e3) * 3600e3);
  const rows = [];
  for (const [m, lab] of Object.entries(MODELS)) {
    const t2 = series[m].temperature_2m || [];
    const use = isToday ? idx.filter((i) => times[i] >= hourNow) : idx;
    const vals = use.map((i) => t2[i]).filter((v) => v != null);
    if (vals.length < (isToday ? 3 : 18)) continue;
    const raw = Math.max(...vals), pi = use.find((i) => t2[i] === raw), sc = scores[m];
    const row = { model: lab, raw: r1(raw), peak: hh(times[pi]), bias: sc.bias, mae: sc.mae, n: sc.n, pace: null };
    let corr = raw + sc.bias;
    if (isToday && ob) {
      const oh = Math.floor(ob.nowT.getTime() / 3600e3) * 3600e3;
      const oi = times.findIndex((t) => t.getTime() === oh);
      if (oi >= 0 && t2[oi] != null) {
        const pace = (ob.nowFit ?? ob.nowF) - t2[oi], h = ob.nowT.getUTCHours();
        const carry = h < 8 ? 0.25 : h < 10 ? 0.45 : h < 13 ? 0.65 : 0.8;
        row.pace = r1(pace);
        corr = raw + (1 - carry) * sc.bias + carry * pace; // pace already carries the model's usual bias
      }
    }
    row.corr = r1(corr); row.w = 1 / (sc.mae ** 2 + 0.5);
    rows.push(row);
  }
  if (!rows.length) return { error: "No model data for this day yet." };
  const W = rows.reduce((s, r) => s + r.w, 0); rows.forEach((r) => (r.w = Math.round((r.w / W) * 1000) / 1000)); rows.sort((a, b) => b.w - a.w);
  const vals = rows.map((r) => r.corr), ws = rows.map((r) => r.w);
  let mu = wmean(vals, ws); const blend = r1(mu);
  const n = nws[ymd(day)] || {};
  const sc0 = learned?.selfcal?.[isToday ? "today" : "tomorrow"];
  const hNow = now.getUTCHours() + now.getUTCMinutes() / 60;
  if (n.high != null && !(isToday && hNow >= 16)) mu = (1 - CFG.nwsWeight) * mu + CFG.nwsWeight * n.high;
  if (ana) { const a = isToday ? CFG.analogWeightToday : CFG.analogWeightTomorrow; mu = (1 - a) * mu + a * ana.median; }
  const meanRaw = r1(mu);
  // self-correction: the dashboard's own recent average miss (shrunk, ±2 °F max)
  const hourObs = isToday && ob ? ob.nowT.getUTCHours() : null;
  const wEmp = hourObs == null ? 0 : Math.max(0, Math.min(0.55, 0.08 * (hourObs - 8)));
  const selfAdj = sc0?.adj ? sc0.adj * (1 - wEmp) : 0;
  mu += selfAdj;
  const v = wmean(vals.map((x) => (x - mu) ** 2), ws);
  let base = CFG.sdTomorrow;
  if (isToday) { const left = Math.max(0, CFG.peakHour - hNow); base = hNow >= 16 ? 0.35 : 0.45 + 1.15 * Math.min(1, left / 8); }
  const sd = Math.max(0.5, Math.sqrt(v * (isToday ? 0.6 : 1) + base ** 2));
  let floor = isToday && ob ? ob.maxSoFar : null;
  const wh = isToday && wethr?.date === ymd(day) && wethr.high != null ? wethr.high : null;
  if (wh != null && (floor == null || wh > floor)) floor = wh;
  const pLess = (x) => (floor != null && x <= floor ? 0 : ncdf((x - mu) / sd));
  let lo = Math.floor(mu - 6 * sd) - 2, hi = Math.ceil(mu + 6 * sd) + 2;
  if (floor != null) lo = Math.min(lo, Math.floor(floor) - 1);
  const dist = {}; let tot = 0;
  for (let k = lo; k <= hi; k++) { const p = Math.max(0, pLess(k + 0.5) - pLess(k - 0.5)); dist[k] = p; tot += p; }
  for (const k in dist) dist[k] /= tot || 1;
  // blend in the nowcast: history conditioned on the last-hour trend and current sky (fallback: pacing table)
  let pacing = null;
  if (isToday && ob && learned) {
    const nc = nowcast(learned, ob, reg?.sector || "all", floor, kal?.brackets, hNow);
    if (nc) {
      const keys = new Set([...Object.keys(dist), ...Object.keys(nc.emp)]);
      if (wEmp > 0 && Object.keys(nc.emp).length) for (const k of keys) dist[k] = (1 - wEmp) * (dist[k] || 0) + wEmp * (nc.emp[k] || 0);
      pacing = { ...nc, weight: wEmp, sector: reg?.sector || "all", maxSoFar: ob.maxSoFar };
    }
  }
  const point = +Object.entries(dist).reduce((a, b) => (b[1] > a[1] ? b : a))[0];
  const expected = Object.entries(dist).reduce((s, [k, p]) => s + k * p, 0);
  const brackets = (kal?.brackets || []).map((b) => {
    const L = b.lo ?? -999, H = b.hi ?? 999;
    const mp = Object.entries(dist).filter(([k]) => +k >= L && +k <= H).reduce((s, [, p]) => s + p, 0);
    return { ...b, model_p: mp, edge: b.p == null ? null : mp - b.p };
  });
  const call = brackets.length ? brackets.reduce((a, b) => (b.model_p > a.model_p ? b : a)) : null;
  // checkpoints: whole-°C 1-minute readings and METAR T-group lines
  const cps = [];
  for (let c = Math.floor(((mu - 5) - 32) * 5 / 9); c <= Math.ceil(((mu + 4) - 32) * 5 / 9); c++) {
    const lo = c2f(c - 0.5), hi = c2f(c + 0.5);
    cps.push({ c, f: r1(c2f(c)), lo: r1(lo), hi: r1(hi - 0.05) });
  }
  const tg = brackets.filter((b) => b.lo != null && Math.abs(b.lo - mu) <= 5).map((b) => {
    const need = b.lo - 0.5, tc = Math.ceil(((need - 32) * 5 / 9) * 10 - 1e-9) / 10;
    return { bracket: b.label, needF: need, tgroup: `T${tc < 0 ? 1 : 0}${String(Math.abs(Math.round(tc * 10))).padStart(3, "0")}`, oneMinC: Math.round(tc) - 0.5 >= tc ? Math.round(tc) : Math.ceil(tc) };
  });
  const spike = learned?.spike?.[reg?.sector] || learned?.spike?.all || null;
  return { date: ymd(day), isToday, call: call?.label ?? null, callP: call?.model_p ?? null, point, mean: r1(mu), meanRaw, selfAdj: r1(selfAdj), selfcal: sc0 || null, pacing, spike, wethr: wh != null ? wethr : null, blend, expected: r1(expected), sd: Math.round(sd * 100) / 100, floor, models: rows, nws: n,
    dist: Object.entries(dist).filter(([, p]) => p >= 0.004).map(([k, p]) => ({ k: +k, p })), brackets, kalshi: { event: kal?.event, noMarket: kal?.noMarket, peak: kal?.peak, window: kal?.window, implied: kal?.implied, error: kal?.error }, checkpoints: cps, tgroups: tg };
}

export function summarize(fc, reg) {
  if (fc.error) return fc.error;
  const parts = [`Call ${fc.point} (${fc.call || "—"}${fc.callP != null ? ", " + Math.round(fc.callP * 100) + "%" : ""}).`];
  if (fc.kalshi.noMarket) parts.push("Kalshi market not trading yet.");
  else if (fc.kalshi.peak) parts.push(`Kalshi peak ${fc.kalshi.peak}, implied ~${fc.kalshi.implied}.`);
  parts.push(`Bias-corrected blend ${fc.mean} ± ${fc.sd} °F.`);
  if (fc.floor != null) parts.push(`Observed high so far ${fc.floor} °F${fc.wethr ? " (wethr, incl. 1-min)" : ""}.`);
  if (fc.pacing) {
    const pc = fc.pacing, up1 = Object.entries(pc.emp).filter(([k]) => +k >= pc.base + 1).reduce((s, [, p]) => s + p, 0);
    const hl = pc.hour > 12 ? pc.hour - 12 + " PM" : pc.hour === 12 ? "12 PM" : pc.hour + " AM";
    parts.push(`Nowcast ${hl}: ${pc.rate != null ? (pc.rate >= 0 ? "+" : "") + pc.rate + " °F/h" : "rate n/a"}, last hour ${pc.trend != null ? (pc.trend >= 0 ? "+" : "") + pc.trend : "?"}, ${pc.sky}${pc.gusty ? ", gusty" : ""}; on ${pc.n} similar past days the CLI ended above ${pc.base} ${Math.round(up1 * 100)}% of the time (avg +${pc.meanRise}).`);
  }
  if (fc.selfAdj) parts.push(`Self-correction ${fc.selfAdj > 0 ? "+" : ""}${fc.selfAdj} °F from recent misses.`);
  const by = fc.brackets.filter((b) => b.edge != null).sort((a, b) => b.edge - a.edge);
  if (by[0] && by[0].edge >= 0.08) parts.push(`Cheap: ${by[0].label} (${Math.round(by[0].model_p * 100)}% vs market ${Math.round(by[0].p * 100)}%).`);
  const w = by[by.length - 1];
  if (w && w.edge <= -0.08) parts.push(`Rich: ${w.label} (${Math.round(w.model_p * 100)}% vs market ${Math.round(w.p * 100)}%).`);
  return parts.join(" ");
}

/* ---------------- one-shot run ---------------- */
export async function runForecast({ inBrowser, kalshi, learned, wethr }) {
  const now = estNow(), today = dayStart(now), tomorrow = addDays(today, 1), errors = [];
  const safe = async (name, p, dflt) => { try { return await p; } catch (e) { errors.push(`${name}: ${e.message}`); return dflt; } };
  const [mod, cli, obs, nws, hist] = await Promise.all([
    fetchModels(), safe("cli", fetchCliHighs(), {}), safe("obs", fetchObs(inBrowser), []),
    safe("nws", fetchNws(), {}), safe("history", fetchHistory(tomorrow), []),
  ]);
  const { times, series } = mod;
  // merge wethr's 5-min obs (fresher than the NWS API) into the METAR list
  if (wethr?.obs?.length) {
    const have = new Set(obs.map((o) => Math.round(o.t.getTime() / 60e3)));
    for (const w of wethr.obs) {
      const t = new Date(Date.parse(w.t) + OFF);
      if (w.c == null || have.has(Math.round(t.getTime() / 60e3))) continue;
      obs.push({ t, tC: w.c, dewC: w.dew, wdir: w.wd ?? "VRB", wspd: w.ws, wgst: w.wg, sky: "", wx: "", raw: "", fromMetar: false,
        floorF: w.lo != null ? w.lo - 0.5 : r1(c2f(w.c - 0.5)), src: "wethr 5-min" });
    }
    obs.sort((a, b) => a.t - b.t);
  }
  const scores = scoreModels(times, series, cli, today);
  const out = { station: STATION, generated: now, generatedTxt: `${hm(now)} EST`, scores, cli, errors };
  for (const [lab, day] of [["today", today], ["tomorrow", tomorrow]]) {
    const kal = kalshi?.[lab] || (inBrowser ? null : await safe("kalshi", fetchKalshiDirect(day), null)) || { brackets: [] };
    const reg = regime(times, series, day);
    const ana = analogs(hist, day, reg);
    const ob = lab === "today" ? obsToday(obs, day) : null;
    const fc = forecastDay({ day, now, times, series, scores, nws, kal, ob, ana, learned, reg, wethr });
    Object.assign(fc, { regime: reg, analogs: ana, obs: ob, summary: summarize(fc, reg) });
    out[lab] = fc;
  }
  return out;
}
