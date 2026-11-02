/* ============================================================
   KMIA PWS POLYGON ENGINE — Miami Intl high-temp nowcaster
   ------------------------------------------------------------
   Pool of public Ambient Weather PWS inside a polygon around
   KMIA, QC'd and averaged, tracked against the KMIA ASOS
   (METAR via api.weather.gov) and a ring of five metro
   fields: KFLL · KHWO · KOPF · KTMB · KHST.

   EVERYTHING TUNABLE LIVES IN CONFIG BELOW.
   - Reshape the capture zone: edit CONFIG.polygon ([lon, lat]
     points, any order that walks the ring). The map redraws and
     the pool re-filters automatically. Grey dots on the map are
     nearby stations currently OUTSIDE the polygon.
   - QC thresholds: CONFIG.qc
   - Health / quarantine rules: CONFIG.health
   - Sea-breeze sector / burst rules: CONFIG.breeze
   ============================================================ */
"use strict";

const CONFIG = {
  station: {
    icao: "KMIA",
    label: "Miami Intl",
    lat: 25.7906,
    lon: -80.3164,
  },

  // Capture polygon ([lon, lat]) — tight local zone: the field
  // plus only its first ring of neighborhoods. Miami Springs and
  // the Hialeah south rim above, Fontainebleau / east Doral edge
  // west, Westchester / Coral Terrace / Blue Lagoon below, and a
  // short eastern lip into Allapattah / Grapeland as the
  // sea-breeze sentinel. Hialeah proper, Doral proper, Wynwood,
  // Coral Gables and everything coastal are outside.
  polygon: [
    [-80.385, 25.828],
    [-80.315, 25.838],
    [-80.268, 25.822],
    [-80.243, 25.788],
    [-80.256, 25.752],
    [-80.303, 25.742],
    [-80.362, 25.748],
    [-80.390, 25.783],
  ],

  // East / west cohort split. Stations east of this meridian feel
  // the sea breeze first; when the east cohort cools while the
  // west holds, the front is crossing the polygon toward the field.
  splitLon: -80.31,

  // Metro METAR ring (KMIA-only feature) — official fields around
  // the polygon, checked alongside the pool.
  ring: [
    { id: "KFLL", lab: "N 31 km",  lat: 26.0726, lon: -80.1527 },
    { id: "KHWO", lab: "N 24 km",  lat: 26.0012, lon: -80.2407 },
    { id: "KOPF", lab: "N 13 km",  lat: 25.9070, lon: -80.2784 },
    { id: "KTMB", lab: "SW 20 km", lat: 25.6479, lon: -80.4328 },
    { id: "KHST", lab: "S 34 km",  lat: 25.4886, lon: -80.3836 },
  ],

  bboxPadDeg: 0.15,      // fetch this far beyond the polygon; extras shown grey
  pollMs: 60 * 1000,     // AW pool poll
  metarMs: 5 * 60 * 1000,

  qc: {
    staleMin: 40,        // drop readings older than this (minutes)
    absMinF: 30,         // absolute plausibility gate for Miami, °F
    absMaxF: 110,
    grossDeltaF: 9,      // drop if this far (°F) from a fresh KMIA ob
    madK: 3.5,           // robust outlier: |x - median| > max(minBandF, madK * 1.4826 * MAD)
    minBandF: 2.5,       // never drop inside ±2.5 °F of the pool median
    flatWindowMin: 120,  // flatliner detection window
    flatStationSpanF: 0.3,
    flatGroupSpanF: 1.5, // only call it flat if the pool itself moved this much
    flatMinSamples: 8,
  },

  health: {
    everyMin: 60,        // hourly sweep (also runs on load)
    minSamples: 24,      // ~2 h of 5-min samples before a station gets judged
    quarStdF: 3.5,       // quarantine: noisy vs official
    quarBiasF: 7.0,      // quarantine: absurd persistent offset
    quarFlatFrac: 0.5,   // quarantine: flat in most eligible hours
    watchBiasF: 2.2,
    watchStdF: 2.2,
    maxBiasCorrF: 6.0,   // cap applied when bias-correcting the pool mean
  },

  breeze: {
    onshoreDeg: [60, 170], // METAR wind sector treated as sea breeze at KMIA
    onshoreMinKt: 7,
    burstKt: 10,           // BREEZE IN + this sustained → gust-mix burst watch
    burstGustKt: 14,       // …or gusting this
  },
};

/* ============================================================
   Pure helpers — no DOM, no fetch. Also exercised by the node
   self-tests at the bottom (`node app.js`).
   ============================================================ */

const f2c = (f) => ((f - 32) * 5) / 9;
const c2f = (c) => (c * 9) / 5 + 32;
const r1 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 10) / 10);
const r2 = (x) => (x == null || !isFinite(x) ? null : Math.round(x * 100) / 100);
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function pstdev(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) * (x - m))));
}
// q-th percentile of an ASCENDING array (nearest-rank).
function pctl(sorted, q) {
  if (!sorted.length) return null;
  const i = clamp(Math.ceil(q * sorted.length) - 1, 0, sorted.length - 1);
  return sorted[i];
}

function distKm(lat1, lon1, lat2, lon2) {
  const kx = 111.32 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
  const dx = (lon2 - lon1) * kx;
  const dy = (lat2 - lat1) * 110.574;
  return Math.sqrt(dx * dx + dy * dy);
}

// Ray casting; ring = [[lon,lat], ...] open or closed.
function pointInPolygon(lon, lat, ring) {
  let pts = ring;
  const n0 = pts.length;
  if (n0 > 1 && pts[0][0] === pts[n0 - 1][0] && pts[0][1] === pts[n0 - 1][1]) {
    pts = pts.slice(0, n0 - 1);
  }
  let inside = false;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    if ((y1 > lat) !== (y2 > lat)) {
      const xin = ((x2 - x1) * (lat - y1)) / (y2 - y1) + x1;
      if (lon < xin) inside = !inside;
    }
  }
  return inside;
}

function bboxOf(ring, pad) {
  const lons = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  return {
    w: Math.min(...lons) - pad,
    e: Math.max(...lons) + pad,
    s: Math.min(...lats) - pad,
    n: Math.max(...lats) + pad,
  };
}

/* ---------- QC pipeline ----------
   stations: [{id, name, lat, lon, tempf, obsMs}]  (already inside polygon)
   ctx: {
     nowMs, officialF, officialAgeMin,
     forced: {id: "block"|"allow"},
     quarantined: Set(id),
     fineHist: Map(id -> [{t, f}]),   // recent per-station samples
     groupSpanF,                      // pool movement over the flat window
     cfg
   }
   Mutates each station with qc:"keep"|"drop" and reasons[].       */
function qcPool(stations, ctx) {
  const cfg = ctx.cfg;
  const survivors = [];
  for (const s of stations) {
    s.qc = null;
    s.reasons = [];
    const reasons = [];
    const forced = ctx.forced[s.id];
    s.ageMin = (ctx.nowMs - s.obsMs) / 60000;
    if (forced === "block") reasons.push("blocked");
    if (forced !== "allow" && ctx.quarantined.has(s.id)) reasons.push("quarantine");
    if (s.ageMin > cfg.staleMin) reasons.push("stale");
    if (s.tempf < cfg.absMinF || s.tempf > cfg.absMaxF) reasons.push("range");
    if (
      ctx.officialF != null &&
      ctx.officialAgeMin != null &&
      ctx.officialAgeMin <= 75 &&
      Math.abs(s.tempf - ctx.officialF) > cfg.grossDeltaF
    ) {
      reasons.push("gross \u0394");
    }
    // flatliner: enough recent samples, station barely moved, pool clearly did
    const hist = ctx.fineHist.get(s.id) || [];
    const cut = ctx.nowMs - cfg.flatWindowMin * 60000;
    const recent = hist.filter((p) => p.t >= cut).map((p) => p.f);
    if (
      recent.length >= cfg.flatMinSamples &&
      Math.max(...recent) - Math.min(...recent) <= cfg.flatStationSpanF &&
      ctx.groupSpanF != null &&
      ctx.groupSpanF >= cfg.flatGroupSpanF
    ) {
      reasons.push("flatline");
    }
    if (reasons.length) {
      s.qc = "drop";
      s.reasons = reasons;
    } else {
      survivors.push(s);
    }
  }
  // robust outlier pass on survivors
  if (survivors.length >= 4) {
    const temps = survivors.map((s) => s.tempf);
    const med = median(temps);
    const mad = median(temps.map((t) => Math.abs(t - med)));
    const band = Math.max(cfg.minBandF, cfg.madK * 1.4826 * mad);
    for (const s of survivors) {
      if (Math.abs(s.tempf - med) > band) {
        s.qc = "drop";
        s.reasons = ["outlier"];
      }
    }
  }
  const kept = survivors.filter((s) => s.qc !== "drop");
  for (const s of kept) {
    s.qc = "keep";
    s.reasons = [];
  }
  const dropped = stations.filter((s) => s.qc === "drop");
  return { kept, dropped };
}

/* ---------- pool statistics (°F) ---------- */
function poolStats(kept, biases, maxBiasCorrF) {
  const n = kept.length;
  if (!n) return { n: 0 };
  const tempsF = kept.map((s) => s.tempf).sort((a, b) => a - b);
  const corr = kept.map((s) => {
    const b = biases[s.id];
    const adj = typeof b === "number" && isFinite(b) ? clamp(b, -maxBiasCorrF, maxBiasCorrF) : 0;
    return s.tempf - adj;
  });
  const trimmed = n >= 5 ? tempsF.slice(1, n - 1) : tempsF;
  let top = kept[0];
  for (const s of kept) if (s.tempf > top.tempf) top = s;
  return {
    n,
    meanF: mean(tempsF),
    medianF: median(tempsF),
    trimmedF: mean(trimmed),
    correctedF: mean(corr),
    spreadF: tempsF[n - 1] - tempsF[0],
    p90F: pctl(tempsF, 0.9),     // hot edge — the settle-relevant tail
    topF: tempsF[n - 1],
    topName: top.name,
  };
}

/* ---------- east / west cohorts ----------
   East of splitLon feels the sea breeze first. dEW = east − west
   (°F): clearly negative = front crossing the polygon.           */
function cohortSplit(kept, splitLon) {
  const e = [], w = [];
  for (const s of kept) (s.lon >= splitLon ? e : w).push(s.tempf);
  return {
    eN: e.length, wN: w.length,
    eMeanF: mean(e), wMeanF: mean(w),
    dEW: e.length && w.length ? mean(e) - mean(w) : null,
  };
}

/* ---------- rate of rise / fall ----------
   series: [{t(ms), v}] ascending. °F per hour between the latest
   point and the sample nearest (now - backMin), within tolMin.   */
function slopePerHr(series, backMin, tolMin = 6) {
  if (!series || series.length < 2) return null;
  const last = series[series.length - 1];
  const target = last.t - backMin * 60000;
  let best = null;
  for (const p of series) {
    const d = Math.abs(p.t - target);
    if (best == null || d < best.d) best = { p, d };
  }
  if (!best || best.d > tolMin * 60000) return null;
  const dtHr = (last.t - best.p.t) / 3.6e6;
  if (dtHr <= 0.01) return null;
  return (last.v - best.p.v) / dtHr;
}

/* ---------- Miami time (America/New_York) ---------- */
const ET_TZ = "America/New_York";
const _etFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: ET_TZ, hour12: false,
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit",
});
function etParts(ms) {
  const out = {};
  for (const p of _etFmt.formatToParts(new Date(ms))) out[p.type] = p.value;
  if (out.hour === "24") out.hour = "00";
  return out;
}
function etHM(ms) {
  const p = etParts(ms);
  return `${p.hour}:${p.minute}`;
}
function etMidnightMs(ms) {
  const p = etParts(ms);
  const wallAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  const offset = wallAsUtc - Math.floor(ms / 60000) * 60000; // ET = UTC + offset
  return Date.UTC(+p.year, +p.month - 1, +p.day) - offset;
}

/* ---------- METAR raw fallback parser ---------- */
function parseMetarRaw(raw) {
  const out = { c: null, wdir: null, wspd: null, gust: null };
  if (!raw) return out;
  const t = raw.match(/\s(M?\d{2})\/(M?\d{2})\s/);
  if (t) out.c = parseInt(t[1].replace("M", "-"), 10);
  const w = raw.match(/\s(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT\s/);
  if (w) {
    out.wdir = w[1] === "VRB" ? null : parseInt(w[1], 10);
    out.wspd = parseInt(w[2], 10);
    out.gust = w[3] != null ? parseInt(w[3], 10) : null;
  }
  return out;
}

/* One api.weather.gov observation -> the same row shape the AWC
   parser emits. NWS reports wind in km/h; the dashboard runs on
   knots everywhere, so convert. Rows without a numeric temperature
   are useless to the pool delta and are skipped. */
function nwsRow(props) {
  if (!props) return null;
  const c = props.temperature ? props.temperature.value : null;
  if (typeof c !== "number") return null;
  const t = Date.parse(props.timestamp || "");
  if (!t || isNaN(t)) return null;
  const kt = (v) => (typeof v === "number" ? Math.round(v / 1.852) : null);
  return {
    t, c, f: c2f(c),
    wdir: props.windDirection && typeof props.windDirection.value === "number"
      ? props.windDirection.value : null,
    wspd: kt(props.windSpeed ? props.windSpeed.value : null),
    gust: kt(props.windGust ? props.windGust.value : null),
    raw: props.rawMessage || "",
  };
}

/* One IEM currents row (mesonet.agron.iastate.edu) -> the same row shape.
   IEM already reports °F and knots. Station ids come back without the
   leading K (MIA, FLL…). Rows whose METAR has no temperature (sensor out,
   e.g. a "$" maintenance flag) return null. */
function iemRow(d) {
  if (!d) return null;
  const f = typeof d.tmpf === "number" ? d.tmpf : null;
  if (f == null) return null;
  const ts = String(d.utc_valid || "");
  const t = Date.parse(/Z$|[+-]\d\d:\d\d$/.test(ts) ? ts : ts + "Z");
  if (!t || isNaN(t)) return null;
  const num = (v) => (typeof v === "number" ? v : null);
  return { t, c: ((f - 32) * 5) / 9, f, wdir: num(d.drct), wspd: num(d.sknt), gust: num(d.gust), raw: d.raw || "" };
}

/* ---------- health sweep ----------
   st5: Map(id -> {name, pts:[[t, tempf], ...]})   (5-min samples, ~26 h)
   officialSeries: [{t, f}]  (KMIA, °F)
   Stable bias is NOT a quarantine offence — it gets corrected.
   Instability, absurd offsets and flatlining are.                */
function healthSweep(st5, officialSeries, nowMs, cfg, forced) {
  const out = { t: nowMs, stations: {} };
  const off = officialSeries || [];
  const nearestOfficial = (t) => {
    let best = null;
    for (const p of off) {
      const d = Math.abs(p.t - t);
      if (best == null || d < best.d) best = { p, d };
    }
    return best && best.d <= 40 * 60000 ? best.p.f : null; // METARs are hourly + specials
  };
  const dayCut = nowMs - 24 * 3600 * 1000;
  for (const [id, rec] of st5.entries()) {
    const pts = rec.pts.filter((p) => p[0] >= dayCut);
    const resid = [];
    for (const [t, f] of pts) {
      const of = nearestOfficial(t);
      if (of != null) resid.push(f - of);
    }
    const n = resid.length;
    const bias = n ? median(resid) : null;
    const std = n ? pstdev(resid) : null;
    // flat fraction: hours where the station barely moved while official clearly did
    let flatHours = 0, eligHours = 0;
    for (let h = 0; h < 24; h++) {
      const a = nowMs - (h + 1) * 3600e3, b = nowMs - h * 3600e3;
      const sp = pts.filter((p) => p[0] >= a && p[0] < b).map((p) => p[1]);
      const op = off.filter((p) => p.t >= a && p.t < b).map((p) => p.f);
      if (sp.length >= 6 && op.length >= 2 && Math.max(...op) - Math.min(...op) >= 1.0) {
        eligHours++;
        if (Math.max(...sp) - Math.min(...sp) <= 0.4) flatHours++;
      }
    }
    const flatFrac = eligHours ? flatHours / eligHours : 0;
    let status;
    if (forced[id] === "allow") status = "good";
    else if (n < cfg.minSamples) status = "new";
    else if (Math.abs(bias) > cfg.quarBiasF || std > cfg.quarStdF || flatFrac > cfg.quarFlatFrac) status = "quarantine";
    else if (Math.abs(bias) > cfg.watchBiasF || std > cfg.watchStdF) status = "watch";
    else status = "good";
    out.stations[id] = {
      name: rec.name,
      n,
      bias: r2(bias),
      std: r2(std),
      flatFrac: r2(flatFrac),
      status,
      lastSeen: pts.length ? pts[pts.length - 1][0] : null,
    };
  }
  return out;
}

/* ============================================================
   Browser application
   ============================================================ */
if (typeof window !== "undefined") {
  (() => {
    const $ = (id) => document.getElementById(id);
    const cfg = CONFIG;

    /* ---------- persistence ---------- */
    const LS = {
      pool: "kmia_pws_v1_pool",
      st5: "kmia_pws_v1_st5",
      health: "kmia_pws_v1_health",
      forced: "kmia_pws_v1_forced",
    };
    const lsGet = (k, fb) => {
      try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fb; }
      catch { return fb; }
    };
    const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota — skip */ } };

    /* ---------- state ---------- */
    const S = {
      poolSeries: lsGet(LS.pool, []),          // [{t, corr, mean, med, p90, n, top, topName}]
      st5: new Map(),                          // id -> {name, pts:[[t, f]]}
      fine: new Map(),                         // id -> [{t, f}] (last ~3 h, per poll)
      health: lsGet(LS.health, { t: 0, stations: {} }),
      forced: lsGet(LS.forced, {}),            // id -> "block" | "allow"
      metarSeries: [],                         // KMIA [{t, f, c, wdir, wspd, gust, raw}]
      ring: {},                                // id -> latest {t, f, wdir, wspd, gust}
      stations: [],                            // latest AW parse (in + out of polygon)
      feeds: { aw: { ok: null }, metar: { ok: null }, ring: { ok: null } },
      lastPollMs: null,
      map: null, mapLayers: [], ringLayers: [],
    };
    // rehydrate st5
    for (const [id, rec] of Object.entries(lsGet(LS.st5, {}))) {
      S.st5.set(id, rec);
      S.fine.set(id, rec.pts.slice(-40).map(([t, f]) => ({ t, f })));
    }

    /* ---------- feeds ---------- */
    async function jget(url) {
      const r = await fetch(url, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }

    async function fetchAW() {
      const b = bboxOf(cfg.polygon, cfg.bboxPadDeg);
      const p = new URLSearchParams();
      p.set("$publicBox[0][0]", b.w); p.set("$publicBox[0][1]", b.s);
      p.set("$publicBox[1][0]", b.e); p.set("$publicBox[1][1]", b.n);
      p.set("$limit", "300");
      const js = await jget(`https://lightning.ambientweather.net/devices?${p.toString()}`);
      const arr = Array.isArray(js) ? js : js.data || [];
      const out = [];
      const seen = new Set();
      for (const d of arr) {
        const last = d.lastData || {};
        const info = d.info || {};
        const cc = (info.coords && info.coords.coords) || {};
        let lat = cc.lat, lon = cc.lon;
        if (lat == null || lon == null) {
          const geo = info.coords && info.coords.geo && info.coords.geo.coordinates;
          if (geo && geo.length === 2) { lon = geo[0]; lat = geo[1]; }
        }
        const id = d.macAddress || d._id;
        if (id == null || lat == null || lon == null) continue;
        if (typeof last.tempf !== "number" || typeof last.dateutc !== "number") continue;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({
          id: String(id),
          name: String(info.name || "PWS").replace(/[",\n]/g, " ").slice(0, 34),
          lat: +lat, lon: +lon,
          tempf: last.tempf,
          obsMs: last.dateutc,
          inPoly: pointInPolygon(+lon, +lat, cfg.polygon),
          distKm: distKm(+lat, +lon, cfg.station.lat, cfg.station.lon),
        });
      }
      return out;
    }

    // One AWC call can carry several ICAOs — returns Map(icao -> ascending series).
    async function fetchMetarMulti(idsCsv, hours) {
      const js = await jget(
        `https://aviationweather.gov/api/data/metar?ids=${idsCsv}&format=json&hours=${hours}`
      );
      const arr = Array.isArray(js) ? js : [];
      const by = new Map();
      for (const m of arr) {
        let t = null;
        if (typeof m.obsTime === "number") t = m.obsTime * 1000;
        else if (m.reportTime) t = Date.parse(m.reportTime.replace(" ", "T") + "Z");
        if (!t || isNaN(t)) continue;
        const fb = parseMetarRaw(m.rawOb || "");
        const c = typeof m.temp === "number" ? m.temp : fb.c;
        if (c == null) continue;
        const id = m.icaoId || m.station_id || "";
        if (!by.has(id)) by.set(id, []);
        by.get(id).push({
          t, c, f: c2f(c),
          wdir: typeof m.wdir === "number" ? m.wdir : fb.wdir,
          wspd: typeof m.wspd === "number" ? m.wspd : fb.wspd,
          gust: typeof m.wgst === "number" ? m.wgst : fb.gust,
          raw: m.rawOb || "",
        });
      }
      for (const s of by.values()) s.sort((a, b) => a.t - b.t);
      return by;
    }

    /* NWS API fallback (api.weather.gov) — the same ASOS obs with
       CORS enabled. Used automatically whenever aviationweather.gov
       is unreachable from the browser or answers empty. */
    async function fetchNwsSeries(icao, limit) {
      const js = await jget(`https://api.weather.gov/stations/${icao}/observations?limit=${limit}`);
      const rows = ((js && js.features) || [])
        .map((f) => nwsRow(f && f.properties))
        .filter(Boolean);
      rows.sort((a, b) => a.t - b.t); // NWS returns newest first
      return rows;
    }
    async function fetchNwsLatest(icao) {
      const js = await jget(`https://api.weather.gov/stations/${icao}/observations/latest`);
      return nwsRow(js && js.properties);
    }

    /* Iowa Environmental Mesonet: same ASOS METARs, CORS enabled, one call for
       every field. NWS sometimes blanks a field's temperature for hours, so the
       ring reads from here, and KMIA uses it as a backup. Returns Map(ICAO -> row). */
    async function fetchIemLatest(icaos) {
      const q = icaos.map((i) => "station=" + encodeURIComponent(i.replace(/^K/, ""))).join("&");
      const js = await jget(`https://mesonet.agron.iastate.edu/api/1/currents.json?network=FL_ASOS&${q}&minutes=240`);
      const by = new Map();
      for (const d of (js && js.data) || []) {
        const row = iemRow(d);
        if (row) by.set("K" + d.station, row);
      }
      return by;
    }

    function mergeKmia(series) {
      const by = new Map(S.metarSeries.map((p) => [p.t, p]));
      for (const p of series || []) by.set(p.t, p);
      S.metarSeries = [...by.values()].sort((a, b) => a.t - b.t);
      const cut = Date.now() - 30 * 3600e3;
      S.metarSeries = S.metarSeries.filter((p) => p.t >= cut);
    }

    /* ---------- per-poll pipeline ---------- */
    function groupSpanF(nowMs) {
      const cut = nowMs - cfg.qc.flatWindowMin * 60000;
      const vals = S.poolSeries.filter((p) => p.t >= cut && p.med != null).map((p) => p.med);
      if (vals.length < 4) return null;
      return Math.max(...vals) - Math.min(...vals);
    }

    function computeState(nowMs) {
      const inPoly = S.stations.filter((s) => s.inPoly);
      const metLatest = S.metarSeries[S.metarSeries.length - 1] || null;
      const metPrev = S.metarSeries[S.metarSeries.length - 2] || null;

      const biases = {};
      const quarantined = new Set();
      for (const [id, h] of Object.entries(S.health.stations || {})) {
        if (typeof h.bias === "number") biases[id] = h.bias;
        if (h.status === "quarantine") quarantined.add(id);
      }

      const ctx = {
        nowMs,
        officialF: metLatest ? metLatest.f : null,
        officialAgeMin: metLatest ? (nowMs - metLatest.t) / 60000 : null,
        forced: S.forced,
        quarantined,
        fineHist: S.fine,
        groupSpanF: groupSpanF(nowMs),
        cfg: cfg.qc,
      };
      const { kept } = qcPool(inPoly, ctx);
      const pool = poolStats(kept, biases, cfg.health.maxBiasCorrF);
      const cohorts = cohortSplit(kept, cfg.splitLon);

      // series bookkeeping
      if (pool.n) {
        S.poolSeries.push({
          t: nowMs,
          corr: r2(pool.correctedF),
          mean: r2(pool.meanF),
          med: r2(pool.medianF),
          p90: r2(pool.p90F),
          n: pool.n,
          top: r2(pool.topF),
          topName: pool.topName,
        });
        const cut = nowMs - 26 * 3600e3;
        S.poolSeries = S.poolSeries.filter((p) => p.t >= cut);
        lsSet(LS.pool, S.poolSeries);
      }
      for (const s of inPoly) {
        const f = S.fine.get(s.id) || [];
        if (!f.length || s.obsMs > f[f.length - 1].t) f.push({ t: s.obsMs, f: s.tempf });
        S.fine.set(s.id, f.filter((p) => p.t >= nowMs - 3.5 * 3600e3));
        const rec = S.st5.get(s.id) || { name: s.name, pts: [] };
        rec.name = s.name;
        if (!rec.pts.length || s.obsMs - rec.pts[rec.pts.length - 1][0] >= 5 * 60000 - 5000) {
          rec.pts.push([s.obsMs, s.tempf]);
        }
        rec.pts = rec.pts.filter((p) => p[0] >= nowMs - 26 * 3600e3);
        S.st5.set(s.id, rec);
      }
      lsSet(LS.st5, Object.fromEntries(S.st5));

      // rates
      const corrSeries = S.poolSeries.filter((p) => p.corr != null).map((p) => ({ t: p.t, v: p.corr }));
      const rates = {
        m15: r2(slopePerHr(corrSeries, 15)),
        m30: r2(slopePerHr(corrSeries, 30)),
        m60: r2(slopePerHr(corrSeries, 60)),
        metar: metLatest && metPrev
          ? r2((metLatest.f - metPrev.f) / ((metLatest.t - metPrev.t) / 3.6e6))
          : null,
      };

      // today (ET) maxima
      const mid = etMidnightMs(nowMs);
      let metMax = null;
      for (const p of S.metarSeries) if (p.t >= mid && (!metMax || p.f > metMax.f)) metMax = p;
      let poolMax = null, p90Max = null, spikeMax = null;
      for (const p of S.poolSeries) {
        if (p.t < mid) continue;
        if (p.corr != null && (!poolMax || p.corr > poolMax.v)) poolMax = { v: p.corr, t: p.t };
        if (p.p90 != null && (!p90Max || p.p90 > p90Max.v)) p90Max = { v: p.p90, t: p.t };
        if (p.top != null && (!spikeMax || p.top > spikeMax.v)) spikeMax = { v: p.top, t: p.t, name: p.topName };
      }

      // sea breeze + gust-mix burst watch
      let breeze = null;
      if (metLatest && metLatest.wdir != null && metLatest.wspd != null) {
        const on = metLatest.wdir >= cfg.breeze.onshoreDeg[0] &&
                   metLatest.wdir <= cfg.breeze.onshoreDeg[1] &&
                   metLatest.wspd >= cfg.breeze.onshoreMinKt;
        const burst = on && (metLatest.wspd >= cfg.breeze.burstKt ||
                             (metLatest.gust || 0) >= cfg.breeze.burstGustKt);
        breeze = { dir: metLatest.wdir, kt: metLatest.wspd, gust: metLatest.gust, onshore: on, burst };
      }

      return {
        nowMs, inPoly, kept, pool, cohorts,
        metar: metLatest ? { f: metLatest.f, c: metLatest.c, t: metLatest.t, ageMin: (nowMs - metLatest.t) / 60000, wdir: metLatest.wdir, wspd: metLatest.wspd, gust: metLatest.gust } : null,
        dMetar: pool.n && metLatest ? pool.correctedF - metLatest.f : null,
        dP90: pool.n && metLatest && pool.p90F != null ? pool.p90F - metLatest.f : null,
        rates,
        maxima: { metMax, poolMax, p90Max, spikeMax },
        breeze,
        biases,
      };
    }

    /* ---------- rendering ---------- */
    const fmtF = (f, dp = 1) => (f == null ? "—" : f.toFixed(dp));
    const fmtAge = (m) => (m == null ? "" : m < 1.5 ? "now" : `${Math.round(m)}m`);
    const sgn = (v, dp = 1) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(dp)}`);
    const rateTxt = (v) => (v == null ? "—" : `${v > 0 ? "▲" : v < 0 ? "▼" : "•"} ${Math.abs(v).toFixed(2)}`);
    const rateCls = (v) => (v == null ? "" : v > 0.05 ? "up" : v < -0.05 ? "down" : "");
    const windTxt = (dir, kt, gust) =>
      `${dir == null ? "VRB" : String(dir).padStart(3, "0") + "°"} ${kt == null ? "—" : kt}${gust ? "G" + gust : ""} kt`;

    function setTxt(id, txt) { const el = $(id); if (el && el.textContent !== txt) el.textContent = txt; }
    function setCls(id, cls) { const el = $(id); if (el) el.className = cls; }

    function renderFeeds() {
      for (const k of ["aw", "metar", "ring"]) {
        const f = S.feeds[k];
        const el = $(`dot-${k}`);
        if (el) el.className = "dot " + (f.ok === null ? "wait" : f.ok ? "ok" : "err");
        if (el) el.title = `${k.toUpperCase()} ${f.ok === null ? "connecting" : f.ok ? "ok" : "error: " + (f.err || "")}`;
      }
    }

    function render(st) {
      renderFeeds();
      setTxt("clock", etHM(st.nowMs) + " ET");
      setTxt("lastPoll", S.lastPollMs ? `poll ${fmtAge((st.nowMs - S.lastPollMs) / 60000)}` : "");

      // spread board
      const p = st.pool;
      setTxt("poolF", p.n ? fmtF(p.correctedF) : "—");
      setTxt("poolC", p.n ? `${fmtF(f2c(p.correctedF))} °C` : "");
      setTxt("poolN", p.n
        ? `${p.n} kept · ${st.inPoly.length - p.n} dropped · mean ${fmtF(p.meanF)} · med ${fmtF(p.medianF)} · p90 ${fmtF(p.p90F)} · spread ${fmtF(p.spreadF)}`
        : S.feeds.aw.ok === false
          ? "Ambient Weather feed error"
          : st.inPoly.length === 0 && S.stations.length > 0
            ? "No public stations inside the polygon — grey dots are nearby; widen CONFIG.polygon to capture them"
            : "waiting for first poll…");
      setTxt("offF", st.metar ? fmtF(st.metar.f) : "—");
      setTxt("offAge", st.metar ? `ASOS via METAR · ${fmtAge(st.metar.ageMin)}` : "ASOS via METAR");
      setTxt("metarLine", st.metar
        ? `${fmtF(st.metar.c, 0)} °C · ${windTxt(st.metar.wdir, st.metar.wspd, st.metar.gust)}`
        : "METAR —");

      const d = st.dMetar;
      setTxt("deltaF", sgn(d));
      setCls("deltaF", "delta-num " + (d == null ? "" : d > 0.05 ? "up" : d < -0.05 ? "down" : ""));
      setTxt("deltaP90", st.dP90 == null ? "Δ p90 —" : `Δ p90 ${sgn(st.dP90)} °F`);

      // chips
      for (const [id, v] of [["r15", st.rates.m15], ["r30", st.rates.m30], ["r60", st.rates.m60], ["rMet", st.rates.metar]]) {
        setTxt(id, rateTxt(v));
        setCls(id, "chip-val " + rateCls(v));
      }
      const mx = st.maxima;
      setTxt("hiOff", mx.metMax ? `${fmtF(mx.metMax.f)} @ ${etHM(mx.metMax.t)}` : "—");
      setTxt("hiPool", mx.poolMax ? `pool ${fmtF(mx.poolMax.v)}` : "pool —");
      setTxt("hiSpike",
        (mx.p90Max ? `p90 ${fmtF(mx.p90Max.v)}` : "p90 —") +
        (mx.spikeMax ? ` · top ${fmtF(mx.spikeMax.v)} (${mx.spikeMax.name})` : ""));

      // breeze tile
      if (st.breeze) {
        setTxt("breeze", windTxt(st.breeze.dir, st.breeze.kt, st.breeze.gust));
        setTxt("breezeTag", st.breeze.onshore ? "BREEZE IN — cap risk, high likely set" : "offshore / light — high window open");
        setCls("breezeTag", "chip-sub " + (st.breeze.onshore ? "warn" : "ok"));
        setTxt("burstFlag", st.breeze.burst ? "⚠ gust mix — ASOS can burst above pool" : "");
      } else {
        setTxt("breeze", "—"); setTxt("breezeTag", ""); setTxt("burstFlag", "");
      }

      // breeze-front tile (east vs west cohorts)
      const co = st.cohorts;
      setTxt("frontVal", co.dEW == null ? "—" : `${sgn(co.dEW)} °F`);
      setCls("frontVal", "chip-val " + (co.dEW == null ? "" : co.dEW <= -1.0 ? "down" : co.dEW >= 1.0 ? "up" : ""));
      setTxt("frontTag",
        co.dEW == null
          ? (co.eN + co.wN ? "thin cohorts" : "")
          : co.dEW <= -1.0 ? `east cooling — front inland (${co.eN}E/${co.wN}W)`
          : co.dEW >= 1.0 ? `east warmer — offshore flow (${co.eN}E/${co.wN}W)`
          : `flat — no front signal (${co.eN}E/${co.wN}W)`);

      renderRing(st);
      renderMap(st);
      renderChart(st);
      renderTable(st);
      const h = S.health;
      setTxt("healthTime", h.t ? `health check ${etHM(h.t)} ET` : "health check pending");
    }

    /* ---------- metro ring strip ---------- */
    function renderRing(st) {
      const box = $("ringTiles");
      if (!box) return;
      box.innerHTML = "";
      for (const r of cfg.ring) {
        const d = S.ring[r.id];
        const el = document.createElement("div");
        el.className = "chip rchip";
        const ageMin = d ? (st.nowMs - d.t) / 60000 : null;
        const fresh = d && ageMin <= 95;
        const dK = fresh && st.metar ? d.f - st.metar.f : null;
        const on = fresh && d.wdir != null && d.wspd != null &&
          d.wdir >= cfg.breeze.onshoreDeg[0] && d.wdir <= cfg.breeze.onshoreDeg[1] &&
          d.wspd >= cfg.breeze.onshoreMinKt;
        el.innerHTML =
          `<div class="chip-label">${r.id} · ${r.lab}</div>` +
          `<div class="chip-val">${fresh ? fmtF(d.f) : "—"}</div>` +
          `<div class="chip-sub ${on ? "onshore" : ""}">` +
          (fresh
            ? `Δ ${sgn(dK)} · ${windTxt(d.wdir, d.wspd, d.gust)}`
            : d ? `stale ${fmtAge(ageMin)}` : S.feeds.ring.ok === null ? "…" : "no temp reported") +
          `</div>`;
        box.appendChild(el);
      }
    }

    /* ---------- map ---------- */
    function renderMap(st) {
      if (typeof L === "undefined") return;
      if (!S.map) {
        S.map = L.map("map", { zoomControl: false, attributionControl: true })
          .setView([cfg.station.lat, cfg.station.lon], 12);
        // OSM standard tiles (no API key), darkened via CSS filter in styles.css.
        // CARTO's free basemaps endpoint now stamps "API KEY REQUIRED" on keyless use.
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          attribution: "© OpenStreetMap contributors",
          maxZoom: 18,
          className: "dark-tiles",
        }).addTo(S.map);
        L.polygon(cfg.polygon.map(([lon, lat]) => [lat, lon]), {
          color: "#FF6E93", weight: 1.5, dashArray: "5 4", fillColor: "#FF6E93", fillOpacity: 0.05,
        }).addTo(S.map);
        L.polyline([[25.60, cfg.splitLon], [25.95, cfg.splitLon]], {
          color: "#5A6B80", weight: 1, dashArray: "2 6", interactive: false,
        }).addTo(S.map);
        L.circleMarker([cfg.station.lat, cfg.station.lon], {
          radius: 7, color: "#2ED3C6", weight: 2, fillColor: "#0B1119", fillOpacity: 1,
        }).addTo(S.map).bindTooltip("KMIA · ASOS");
      }
      for (const l of S.mapLayers) S.map.removeLayer(l);
      S.mapLayers = [];
      for (const s of S.stations) {
        let color = "#5A6B80", fill = "#5A6B80", op = 0.5; // outside polygon
        if (s.inPoly) {
          if (s.qc === "keep") { color = "#FF6E93"; fill = "#FF6E93"; op = 0.95; }
          else {
            const r = (s.reasons || []).join(",");
            if (r.includes("stale")) { color = "#8FA0B4"; fill = "#8FA0B4"; op = 0.7; }
            else if (r.includes("quarantine") || r.includes("blocked")) { color = "#B36BFF"; fill = "#B36BFF"; op = 0.8; }
            else { color = "#FF5D5D"; fill = "#FF5D5D"; op = 0.85; }
          }
        }
        const m = L.circleMarker([s.lat, s.lon], { radius: 5, color, weight: 1.5, fillColor: fill, fillOpacity: op })
          .bindTooltip(
            `${s.name} · ${fmtF(s.tempf)} °F · ${fmtAge(s.ageMin ?? (st.nowMs - s.obsMs) / 60000)}` +
            (s.inPoly ? (s.qc === "keep" ? " · in pool" : ` · ${(s.reasons || []).join(", ")}`) : " · outside polygon")
          )
          .addTo(S.map);
        S.mapLayers.push(m);
      }
      // ring field badges (visible when zoomed out)
      for (const l of S.ringLayers) S.map.removeLayer(l);
      S.ringLayers = [];
      for (const r of cfg.ring) {
        const d = S.ring[r.id];
        const txt = d && (st.nowMs - d.t) / 60000 <= 95 ? `${r.id} ${fmtF(d.f, 0)}°` : r.id;
        const b = L.marker([r.lat, r.lon], {
          icon: L.divIcon({ className: "", html: `<div class="ring-badge">${txt}</div>`, iconSize: null }),
          interactive: false,
        }).addTo(S.map);
        S.ringLayers.push(b);
      }
    }

    /* ---------- chart ---------- */
    function renderChart(st) {
      const cv = $("chart");
      if (!cv) return;
      const dpr = window.devicePixelRatio || 1;
      const W = cv.clientWidth, H = cv.clientHeight;
      if (!W || !H) return;
      if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
      const g = cv.getContext("2d");
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);

      const mid = etMidnightMs(st.nowMs);
      const x0 = 34, x1 = W - 8, y0 = 8, y1 = H - 20;
      const X = (t) => x0 + ((t - mid) / 86400000) * (x1 - x0);

      const met = S.metarSeries.filter((p) => p.t >= mid);
      const pol = S.poolSeries.filter((p) => p.t >= mid && p.corr != null);
      const p90 = S.poolSeries.filter((p) => p.t >= mid && p.p90 != null);
      const vals = [...met.map((p) => p.f), ...pol.map((p) => p.corr), ...p90.map((p) => p.p90)];
      if (!vals.length) {
        g.fillStyle = "#8FA0B4"; g.font = "12px 'IBM Plex Mono', monospace";
        g.fillText("No data yet today", x0 + 8, (y0 + y1) / 2);
        return;
      }
      let lo = Math.floor(Math.min(...vals) - 0.5), hi = Math.ceil(Math.max(...vals) + 0.5);
      if (hi - lo < 4) { hi = lo + 4; }
      const step = hi - lo > 14 ? 2 : 1;
      const Y = (f) => y1 - ((f - lo) / (hi - lo)) * (y1 - y0);

      g.strokeStyle = "#223042"; g.fillStyle = "#8FA0B4";
      g.font = "10px 'IBM Plex Mono', monospace"; g.lineWidth = 1;
      for (let f = lo; f <= hi; f += step) {
        g.beginPath(); g.moveTo(x0, Y(f)); g.lineTo(x1, Y(f)); g.stroke();
        g.fillText(String(f), 6, Y(f) + 3);
      }
      for (let h = 0; h <= 24; h += 3) {
        const xh = X(mid + h * 3600e3);
        g.beginPath(); g.moveTo(xh, y0); g.lineTo(xh, y1); g.stroke();
        g.fillText(String(h).padStart(2, "0"), xh - 6, H - 6);
      }
      // now line
      g.strokeStyle = "#3A4A60";
      g.beginPath(); g.moveTo(X(st.nowMs), y0); g.lineTo(X(st.nowMs), y1); g.stroke();

      const line = (pts, getT, getV, color, w, dash) => {
        if (pts.length < 2) return;
        g.strokeStyle = color; g.lineWidth = w;
        if (dash) g.setLineDash(dash);
        g.beginPath();
        pts.forEach((p, i) => {
          const x = X(getT(p)), y = Y(getV(p));
          i ? g.lineTo(x, y) : g.moveTo(x, y);
        });
        g.stroke();
        g.setLineDash([]);
      };
      line(p90, (p) => p.t, (p) => p.p90, "#FFB02E", 1.5, [3, 3]); // hot edge
      line(pol, (p) => p.t, (p) => p.corr, "#FF6E93", 2);          // pool
      line(met, (p) => p.t, (p) => p.f, "#2ED3C6", 1.5);           // KMIA
      g.fillStyle = "#2ED3C6";
      for (const p of met) { g.beginPath(); g.arc(X(p.t), Y(p.f), 2.5, 0, 7); g.fill(); }
      // official daily-max tick
      if (st.maxima.metMax) {
        g.strokeStyle = "#2ED3C6"; g.lineWidth = 1; g.setLineDash([2, 3]);
        g.beginPath(); g.moveTo(x0, Y(st.maxima.metMax.f)); g.lineTo(x1, Y(st.maxima.metMax.f)); g.stroke();
        g.setLineDash([]);
      }
    }

    /* ---------- manifest table ---------- */
    function renderTable(st) {
      const tb = $("stTbody");
      if (!tb) return;
      const rows = [...st.inPoly].sort((a, b) => b.tempf - a.tempf);
      tb.innerHTML = "";
      for (const s of rows) {
        const h = (S.health.stations || {})[s.id] || {};
        const forced = S.forced[s.id];
        const status = forced === "block" ? "blocked"
          : forced === "allow" ? "allowed"
          : s.qc === "keep" ? (h.status || "new") : (s.reasons || []).join(", ");
        const tr = document.createElement("tr");
        tr.className = s.qc === "keep" ? "keep" : "drop";
        const dO = st.metar ? s.tempf - st.metar.f : null;
        tr.innerHTML =
          `<td class="nm">${s.name}</td>` +
          `<td>${s.lon >= cfg.splitLon ? "E" : "W"}</td>` +
          `<td>${s.distKm.toFixed(1)}</td>` +
          `<td class="num">${fmtF(s.tempf)}</td>` +
          `<td>${fmtAge(s.ageMin)}</td>` +
          `<td class="num">${dO == null ? "—" : sgn(dO)}</td>` +
          `<td class="num">${h.bias == null ? "—" : sgn(h.bias)}</td>` +
          `<td class="num">${h.std == null ? "—" : h.std.toFixed(1)}</td>` +
          `<td class="st st-${s.qc}">${status}</td>`;
        const td = document.createElement("td");
        const btn = document.createElement("button");
        btn.className = "blk";
        btn.textContent = forced === "block" ? "unblock" : forced === "allow" ? "auto" : "block";
        btn.addEventListener("click", () => {
          if (forced === "block") S.forced[s.id] = "allow";
          else if (forced === "allow") delete S.forced[s.id];
          else S.forced[s.id] = "block";
          lsSet(LS.forced, S.forced);
          tick(true);
        });
        td.appendChild(btn);
        tr.appendChild(td);
        tb.appendChild(tr);
      }
      setTxt("stCount", `${rows.length} in polygon · ${S.stations.length - rows.length} nearby outside`);
    }

    /* ---------- loops ---------- */
    async function pollAW() {
      try {
        S.stations = await fetchAW();
        S.feeds.aw = { ok: true };
        S.lastPollMs = Date.now();
      } catch (e) { S.feeds.aw = { ok: false, err: String(e) }; }
    }
    const ALL_IDS = [CONFIG.station.icao, ...CONFIG.ring.map((r) => r.id)].join(",");
    async function pollMetarAll() {
      // aviationweather.gov sends no CORS headers, so a browser page can never read it.
      // KMIA series: api.weather.gov. Ring + KMIA backup: Iowa Environmental Mesonet.
      const [nws, iem] = await Promise.allSettled([
        fetchNwsSeries(CONFIG.station.icao, 10),
        fetchIemLatest([CONFIG.station.icao, ...CONFIG.ring.map((r) => r.id)]),
      ]);
      const iemBy = iem.status === "fulfilled" ? iem.value : new Map();
      const kmia = nws.status === "fulfilled" ? nws.value : [];
      const kmiaIem = iemBy.get(CONFIG.station.icao);
      if (kmia.length || kmiaIem) {
        mergeKmia(kmiaIem ? [...kmia, kmiaIem] : kmia);
        S.feeds.metar = { ok: true, src: kmia.length ? "nws" : "iem" };
      } else {
        S.feeds.metar = { ok: false, err: `NWS: ${nws.reason?.message || "no rows"} · IEM: ${iem.reason?.message || "no KMIA row"}` };
      }
      let got = 0;
      const missing = [];
      for (const r of CONFIG.ring) {
        const row = iemBy.get(r.id);
        if (row) { S.ring[r.id] = row; got++; } else missing.push(r.id);
      }
      if (missing.length) {
        const rr = await Promise.allSettled(missing.map((id) => fetchNwsLatest(id)));
        rr.forEach((p, i) => { if (p.status === "fulfilled" && p.value) { S.ring[missing[i]] = p.value; got++; } });
      }
      S.feeds.ring = got ? { ok: true, src: "iem" } : { ok: false, err: "ring empty from IEM and NWS" };
    }

    function runHealth() {
      S.health = healthSweep(S.st5, S.metarSeries, Date.now(), CONFIG.health, S.forced);
      lsSet(LS.health, S.health);
    }

    let busy = false;
    async function tick(recomputeOnly = false) {
      if (busy) return;
      busy = true;
      try {
        if (!recomputeOnly) { await pollAW(); }
        render(computeState(Date.now()));
      } finally { busy = false; }
    }

    async function boot() {
      renderFeeds();
      try {
        mergeKmia(await fetchNwsSeries(CONFIG.station.icao, 120)); // ~24 h incl. specials: today's KMIA curve
        S.feeds.metar = { ok: true, src: "nws" };
      } catch (e) { S.feeds.metar = { ok: false, err: String(e) }; } // pollMetarAll below retries via IEM
      await Promise.all([pollMetarAll(), pollAW()]);
      render(computeState(Date.now()));
      runHealth();
      render(computeState(Date.now()));
      setInterval(tick, CONFIG.pollMs);
      setInterval(() => pollMetarAll(), CONFIG.metarMs);
      setInterval(runHealth, CONFIG.health.everyMin * 60000);
      setInterval(() => setTxt("clock", etHM(Date.now()) + " ET"), 1000);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden) tick();
      });
      window.addEventListener("resize", () => render(computeState(Date.now())));
    }

    boot();
  })();
}

/* ============================================================
   Node self-tests:  node app.js
   ============================================================ */
if (typeof window === "undefined" && typeof process !== "undefined") {
  let fails = 0;
  const ok = (name, cond) => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
    if (!cond) fails++;
  };

  // polygon
  ok("KMIA ASOS inside polygon", pointInPolygon(CONFIG.station.lon, CONFIG.station.lat, CONFIG.polygon));
  ok("Miami Beach outside polygon", !pointInPolygon(-80.130, 25.790, CONFIG.polygon));
  ok("Biscayne Bay outside polygon", !pointInPolygon(-80.190, 25.730, CONFIG.polygon));
  ok("Fontainebleau inside polygon", pointInPolygon(-80.360, 25.780, CONFIG.polygon));
  ok("Miami Springs inside polygon", pointInPolygon(-80.295, 25.822, CONFIG.polygon));
  ok("Hialeah proper outside (tight zone)", !pointInPolygon(-80.290, 25.860, CONFIG.polygon));
  ok("Doral proper outside (tight zone)", !pointInPolygon(-80.400, 25.815, CONFIG.polygon));
  ok("Wynwood outside (tight zone)", !pointInPolygon(-80.200, 25.800, CONFIG.polygon));
  ok("Everglades fringe outside polygon", !pointInPolygon(-80.480, 25.780, CONFIG.polygon));

  const np = nwsRow({
    timestamp: "2026-08-29T14:53:00+00:00",
    temperature: { value: 31.1 },
    windDirection: { value: 120 },
    windSpeed: { value: 20.52 },   // km/h
    windGust: { value: 27.8 },     // km/h
    rawMessage: "KMIA 291453Z 12011G15KT 31/24 A3004",
  });
  ok("NWS row parses temp/time", !!np && Math.abs(np.f - 88.0) < 0.1 && np.t > 0);
  ok("NWS wind converts km/h -> kt", !!np && np.wspd === 11 && np.gust === 15);
  const ir = iemRow({ station: "MIA", utc_valid: "2026-10-24T15:53:00Z", tmpf: 81, drct: 30, sknt: 8, gust: 15, raw: "KMIA 241553Z" });
  ok("IEM row parses °F/kt/time", !!ir && ir.f === 81 && ir.wspd === 8 && ir.gust === 15 && ir.t === Date.parse("2026-10-24T15:53:00Z"));
  ok("IEM sensor-out row skipped", iemRow({ station: "TMB", utc_valid: "2026-10-24T15:53:00Z", tmpf: null }) === null);
  ok("NWS null temp skipped", nwsRow({ timestamp: "2026-08-29T14:53:00+00:00", temperature: { value: null } }) === null);

  // QC synthetic pool (Miami-flavored, °F)
  const now = Date.now();
  const mk = (id, f, ageMin = 3, lon = -80.32) =>
    ({ id, name: id, lat: 25.79, lon, tempf: f, obsMs: now - ageMin * 60000 });
  const stations = [
    mk("a", 88.1), mk("b", 88.4), mk("c", 87.8), mk("d", 88.9), mk("e", 87.5), mk("f", 88.2),
    mk("out", 96.5),          // outlier
    mk("old", 88.0, 90),      // stale
    mk("blk", 88.0),          // manually blocked
    mk("flat", 80.0),         // flatliner (history injected below)
  ];
  const fine = new Map();
  fine.set("flat", Array.from({ length: 12 }, (_, i) => ({ t: now - i * 9 * 60000, f: 80.0 })));
  const ctx = {
    nowMs: now, officialF: null, officialAgeMin: null,
    forced: { blk: "block" }, quarantined: new Set(),
    fineHist: fine, groupSpanF: 3.2, cfg: CONFIG.qc,
  };
  const { kept, dropped } = qcPool(stations, ctx);
  const dropReason = (id) => (dropped.find((s) => s.id === id) || {}).reasons || [];
  ok("outlier dropped", dropReason("out").includes("outlier"));
  ok("stale dropped", dropReason("old").includes("stale"));
  ok("blocked dropped", dropReason("blk").includes("blocked"));
  ok("flatliner dropped", dropReason("flat").includes("flatline"));
  ok("six clean kept", kept.length === 6);

  // gross-Δ gate vs a fresh official ob
  const g = qcPool([mk("g1", 88.2), mk("g2", 99.9)], { ...ctx, officialF: 89.0, officialAgeMin: 10, fineHist: new Map() });
  ok("gross Δ dropped vs official", ((g.dropped.find((s) => s.id === "g2") || {}).reasons || []).includes("gross \u0394"));

  // pool stats + bias correction + p90
  const stats = poolStats(kept, { a: 1.0, b: 0.5 }, 6);
  ok("pool mean sane", Math.abs(stats.meanF - 88.15) < 0.3);
  ok("bias correction shifts mean by -0.25", Math.abs(stats.meanF - stats.correctedF - 0.25) < 0.01);
  ok("top station tracked", stats.topName === "d");
  ok("p90 of 1..10 is 9", pctl([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9) === 9);
  ok("pool p90 at hot edge", Math.abs(stats.p90F - 88.9) < 0.01);

  // cohorts
  const co = cohortSplit(
    [mk("e1", 90, 3, -80.25), mk("e2", 90.4, 3, -80.26), mk("w1", 88, 3, -80.35), mk("w2", 88.4, 3, -80.36)],
    CONFIG.splitLon
  );
  ok("cohort split east minus west = +2", Math.abs(co.dEW - 2) < 0.01);

  // rates: 1.2 °F/h ramp sampled every minute
  const ramp = Array.from({ length: 70 }, (_, i) => ({ t: now - (69 - i) * 60000, v: 85 + (i * 1.2) / 60 }));
  const r30 = slopePerHr(ramp, 30);
  ok("30-min slope ≈ 1.2 °F/h", Math.abs(r30 - 1.2) < 0.05);
  ok("no sample in window → null", slopePerHr(ramp.slice(-3), 60) === null);

  // METAR raw fallback
  const m1 = parseMetarRaw("KMIA 311553Z 10012G18KT 10SM FEW025 SCT250 32/24 A3005 RMK AO2");
  ok("raw METAR temp", m1.c === 32);
  ok("raw METAR wind + gust", m1.wdir === 100 && m1.wspd === 12 && m1.gust === 18);
  ok("raw METAR negative temp", parseMetarRaw("KMIA 311553Z 00000KT M02/M05 A3030 ").c === -2);

  // ET plumbing (July = EDT, UTC−4; January = EST, UTC−5)
  ok("ET midnight in July", etMidnightMs(Date.UTC(2026, 6, 31, 15, 0)) === Date.UTC(2026, 6, 31, 4, 0));
  ok("ET midnight in January", etMidnightMs(Date.UTC(2026, 0, 15, 15, 0)) === Date.UTC(2026, 0, 15, 5, 0));
  ok("ET clock string", etHM(Date.UTC(2026, 6, 31, 4, 0)) === "00:00");

  // health sweep computes a °F bias
  const sweep = healthSweep(
    new Map([["s1", { name: "s1", pts: Array.from({ length: 30 }, (_, i) => [now - i * 5 * 60000, 88 + (i % 3) * 0.2]) }]]),
    Array.from({ length: 40 }, (_, i) => ({ t: now - i * 5 * 60000, f: 88.5 + (i % 4) * 0.1 })),
    now, CONFIG.health, {}
  );
  ok("health computes bias", typeof sweep.stations.s1.bias === "number");

  console.log(fails ? `\n${fails} FAILURES` : "\nALL TESTS PASS");
  process.exit(fails ? 1 : 0);
}
