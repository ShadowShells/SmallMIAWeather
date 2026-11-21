// forecast.html renderer: runs forecast-engine.js live in the browser; falls back to the
// scheduled snapshot (forecast.json) if the model feed is unavailable.
import { runForecast, estNow } from "./forecast-engine.js";

const $ = (id) => document.getElementById(id);
const pct = (p) => (p == null ? "—" : `${Math.round(p * 100)}%`);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
let DATA = null, DAY = "today";
try { DAY = localStorage.getItem("smia_fc_tab") || "today"; } catch { /* private mode */ }

function dot(id, ok) { const d = $(id); if (d) d.className = "dot " + (ok === null ? "wait" : ok ? "ok" : "err"); }
function tick() { const n = estNow(); let h = n.getUTCHours(); const ap = h >= 12 ? "PM" : "AM"; $("clock").textContent = `${h % 12 || 12}:${String(n.getUTCMinutes()).padStart(2, "0")} ${ap} EST`; }

async function getJSON(u) { const r = await fetch(u + "?t=" + Date.now(), { cache: "no-store" }); if (!r.ok) throw new Error(r.status); return r.json(); }

async function load() {
  dot("dot-models", null); dot("dot-obs", null); dot("dot-kalshi", null);
  let kalshi = null, log = {};
  try { kalshi = await getJSON("kalshi.json"); dot("dot-kalshi", true); } catch { dot("dot-kalshi", false); }
  try { log = await getJSON("forecast_log.json"); } catch { /* none yet */ }
  let learned = null, wethr = null;
  try { learned = await getJSON("forecast_learned.json"); } catch { /* not trained yet */ }
  try {
    wethr = await getJSON("wethr.json");
    if (wethr.error || Date.now() - Date.parse(wethr.fetched_utc) > 90 * 60e3) wethr = { ...wethr, stale: true };
  } catch { /* no key set */ }
  let live = true;
  try {
    DATA = await runForecast({ inBrowser: true, kalshi: kalshi || {}, learned, wethr: wethr && !wethr.stale ? wethr : null });
    dot("dot-models", true);
  } catch (e) {
    live = false; dot("dot-models", false);
    try { DATA = await getJSON("forecast.json"); } catch { DATA = null; }
  }
  if (!DATA) { $("meta").textContent = "No data — models and snapshot both unavailable."; return; }
  dot("dot-obs", !!DATA.today?.obs);
  DATA.log = log; DATA.kalshiAt = kalshi?.fetched_utc; DATA.learned = learned; DATA.wethrFile = wethr;
  const w = [];
  if (!live) w.push("Live model feed unavailable — showing the last scheduled snapshot.");
  if (!kalshi) w.push("Kalshi odds file missing — the scheduled job may not have run yet.");
  else if (Date.now() - Date.parse(kalshi.fetched_utc) > 90 * 60e3) w.push(`Kalshi odds are ${Math.round((Date.now() - Date.parse(kalshi.fetched_utc)) / 60e3)} min old.`);
  if (DATA.errors?.length) w.push("Partial data: " + DATA.errors.join("; "));
  $("warn").style.display = w.length ? "block" : "none"; $("warn").textContent = w.join(" ");
  const kAge = kalshi ? Math.round((Date.now() - Date.parse(kalshi.fetched_utc)) / 60e3) : null;
  $("meta").innerHTML = `${live ? "live" : "snapshot"} · updated ${esc(DATA.generatedTxt)}${kAge != null ? ` · odds ${kAge} min old` : ""}`;
  render();
}

function render() {
  document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("on", b.dataset.day === DAY));
  const f = DATA[DAY], reg = f.regime || {};
  if (f.error) { $("warn").style.display = "block"; $("warn").textContent = f.error; return; }
  $("point").textContent = f.point ?? "—";
  $("bracket").textContent = f.call || "no Kalshi brackets";
  $("callp").textContent = f.callP != null ? `${pct(f.callP)} model · ${DAY === "today" ? "today" : "tomorrow"} ${f.date}` : f.date;
  $("f-mean").textContent = `${f.mean} ± ${f.sd}`;
  $("f-kpeak").textContent = f.kalshi?.noMarket ? "not trading" : f.kalshi?.peak || "—";
  $("f-kimp").textContent = f.kalshi?.implied ?? "—";
  $("f-nws").textContent = f.nws?.high != null ? `${f.nws.high}` : "—";
  const o = f.obs;
  $("f-floor").textContent = f.wethr ? `${f.wethr.high} wethr` : o ? `${o.maxSoFar} @ ${o.maxTime}` : "—";
  $("f-now").textContent = o ? `${o.nowRange ? o.nowRange : o.nowF + "°"} ${o.nowTime.replace(" EST", "")}` : "—";
  $("f-now").title = o ? `${o.nowF}° from ${o.nowSrc}${o.nowRange ? " (whole °C, true value " + o.nowRange + " °F)" : ""}` : "";
  $("f-reg").textContent = `${reg.sector || "—"} ${reg.windTxt || ""} ${reg.windKt ?? ""}kt`;
  $("f-storm").textContent = reg.storm || "—";

  // brackets
  const kp = f.kalshi?.peak;
  $("kwin").textContent = f.kalshi?.window ? `window ${f.kalshi.window.from} → ${f.kalshi.window.to} (${pct(f.kalshi.window.cover)})` : "";
  $("tb-br").innerHTML = (f.brackets || []).map((b) => `
    <tr class="${b.label === f.call ? "callrow" : ""}">
      <td>${esc(b.label)}${b.label === kp ? " ◆" : ""}</td>
      <td><span class="barcell">${pct(b.p)} <i class="bar k" style="width:${Math.round((b.p || 0) * 70)}px"></i></span></td>
      <td><span class="barcell">${pct(b.model_p)} <i class="bar m" style="width:${Math.round(b.model_p * 70)}px"></i></span></td>
      <td class="${b.edge >= 0.08 ? "pos" : b.edge <= -0.08 ? "neg" : ""}">${b.edge == null ? "—" : (b.edge >= 0 ? "+" : "") + Math.round(b.edge * 100)}</td>
      <td class="dim">${b.bid != null ? Math.round(b.bid * 100) : "—"} / ${b.ask != null ? Math.round(b.ask * 100) : "—"}</td>
    </tr>`).join("") || `<tr><td colspan="5" class="dim">No Kalshi market found for ${esc(f.kalshi?.event || f.date)}.</td></tr>`;

  // nowcast (learned from history)
  const pc = f.pacing, Ln = DATA.learned, hl = (h) => { const H = Math.floor(h), M = Math.round((h - H) * 60); return `${H % 12 || 12}${M ? ":" + String(M).padStart(2, "0") : ""} ${H >= 12 ? "PM" : "AM"}`; };
  $("pace-panel").style.display = DAY === "today" ? "" : "none";
  if (pc) {
    const sg = (x) => (x == null ? "—" : (x > 0 ? "+" : "") + x);
    $("pace-h").textContent = `${pc.n} similar days · weight ${Math.round(pc.weight * 100)}%`;
    $("nc-chips").innerHTML = [
      ["Rate (60 min)", pc.rate == null ? "—" : `${sg(pc.rate)} °F/h`],
      ["Last hour", pc.trend == null ? "—" : `${sg(pc.trend)} °F`],
      ["Sky now", pc.sky],
      ["Gusts", pc.gust ? `${pc.gust} kt` : "none"],
      ["Usual peak by", hl(pc.peakBy)],
    ].map(([k, v]) => `<div class="fact"><div class="k">${k}</div><div class="v" style="font-size:14px">${esc(v)}</div></div>`).join("");
    const fin = Object.fromEntries((f.dist || []).map((d) => [d.k, d.p]));
    const cls = { "on pace": "pos", "at line now": "pos", reached: "pos", close: "", behind: "neg", "past usual peak": "neg" };
    $("tb-pace").innerHTML = (pc.reach || []).map((r) => {
      const fm = Object.entries(fin).filter(([k]) => +k >= r.lo).reduce((s2, [, p]) => s2 + p, 0);
      return `<tr class="${r.label === f.call ? "callrow" : ""}"><td>≥ ${r.lo} <span class="dim">(${esc(r.label)})</span></td><td>${r.needRate == null ? "—" : sg(r.needRate) + " °F/h"}</td><td class="${cls[r.status] || ""}">${esc(r.status)}</td><td>${pct(r.hist)}</td><td><b>${pct(fm)}</b></td></tr>`;
    }).join("");
  } else {
    $("tb-pace").innerHTML = ""; $("nc-chips").innerHTML = "";
  }
  const lrn = [];
  if (f.spike) lrn.push(`<li><b>1-minute spike:</b> on ${esc(f.regime?.sector || "all")} days the CLI high beat the highest hourly METAR by ≥1 °F <b>${pct(f.spike.ge1)}</b> of the time (avg +${f.spike.mean}). The nowcast already counts this.${f.pacing?.spikeGust ? ` On ${f.pacing.gusty ? "gusty" : "non-gusty"} afternoons like today: ${pct(f.pacing.spikeGust.ge1)}.` : ""}</li>`);
  const sc = f.selfcal;
  if (sc) lrn.push(sc.n >= 5 ? `<li><b>Self-correction:</b> last ${sc.n} ${DAY === "today" ? "morning" : "night-before"} calls missed by ${sc.bias > 0 ? "+" : ""}${sc.bias} °F on average → adjusting ${f.selfAdj > 0 ? "+" : ""}${f.selfAdj} °F.</li>`
    : `<li><b>Self-correction:</b> ${sc.n} graded day${sc.n === 1 ? "" : "s"} so far; switches on at 5.</li>`);
  const wf = DATA.wethrFile;
  lrn.push(f.wethr ? `<li><b>wethr High (NWS logic, incl. 1-min):</b> high <b>${f.wethr.high}</b>${f.wethr.time ? ` at ${esc(f.wethr.time)}` : ""}${f.wethr.sources?.length ? ` (${esc(f.wethr.sources.join(", "))})` : ""}${f.wethr.low != null ? ` · low ${f.wethr.low}${f.wethr.lowTime ? ` at ${esc(f.wethr.lowTime)}` : ""}` : ""} — the high is used as the floor.</li>`
    : wf?.error ? `<li><b>wethr:</b> ${esc(wf.error.slice(0, 90))}</li>` : `<li><b>wethr:</b> not connected (add the <code>WETHR_API_KEY</code> repo secret).</li>`);
  if (Ln) lrn.push(`<li class="dim">Trained ${esc(new Date(Ln.trained).toISOString().slice(0, 16).replace("T", " "))}Z on ${Ln.daysUsed} days (${esc(Ln.window)}).</li>`);
  if ($("learned")) $("learned").innerHTML = lrn.join("");

  // models
  $("tb-mod").innerHTML = (f.models || []).map((m) => `
    <tr><td>${m.model}</td><td>${m.raw}</td><td class="dim">${m.peak}</td>
    <td class="${m.bias > 0 ? "pos" : m.bias < 0 ? "neg" : ""}">${m.bias > 0 ? "+" : ""}${m.bias}</td>
    <td class="dim">${m.mae}${m.n < 3 ? "*" : ""}</td><td>${m.pace == null ? "—" : (m.pace > 0 ? "+" : "") + m.pace}</td>
    <td><b>${m.corr}</b></td><td class="dim">${Math.round(m.w * 100)}%</td></tr>`).join("") +
    (f.nws?.high != null ? `<tr><td>NWS</td><td>${f.nws.high}</td><td class="dim">${f.nws.hourlyMaxTime || ""}</td><td colspan="5" class="dim">${esc(f.nws.text || "")}</td></tr>` : "");

  // regime
  const kv = [["Wind 10 AM–4 PM", `${reg.windTxt || "—"} ${reg.windKt ?? ""} kt`], ["CAPE (90th pct)", `${reg.cape90 ?? "—"} J/kg`], ["Model rain (day)", `${reg.rainIn ?? "—"}"`],
    ["Low cloud", `${reg.lowCloud ?? "—"}%`], ["Total cloud", `${reg.totalCloud ?? "—"}%`], ["850 hPa temp", `${reg.t850F ?? "—"} °F`], ["Max dewpoint", `${reg.dewMax ?? "—"} °F`],
    ["NWS rain chance", f.nws?.popMid != null ? `${f.nws.popMid}%` : "—"], ["Spread", `±${f.sd} °F`]];
  $("kv-reg").innerHTML = kv.map(([k, v]) => `<div class="fact"><div class="k">${k}</div><div class="v" style="font-size:14px">${esc(v)}</div></div>`).join("");
  $("notes").innerHTML = (reg.notes || []).map((n) => `<li>${esc(n)}</li>`).join("");

  // observations
  $("obs-panel").style.display = DAY === "today" ? "" : "none";
  if (DAY === "today" && o) {
    $("obs-src").textContent = `high via ${o.maxSrc}`;
    $("raw").innerHTML = `${esc(o.wind)} · ${esc(o.sky)} · dew ${o.dewF ?? "—"}°F ${o.wx ? "· " + esc(o.wx) : ""}<br>${esc(o.raw || "")}`;
    spark(o.series || [], f);
  }

  // checkpoints
  const bAt = (k) => (f.brackets || []).find((b) => (b.lo ?? -999) <= k && k <= (b.hi ?? 999));
  $("tb-cp").innerHTML = (f.checkpoints || []).map((c) => {
    const lo = Math.round(c.lo), hi = Math.round(c.hi);
    const s = lo === hi ? `${lo}` : `${lo}–${hi}`, b1 = bAt(lo), b2 = bAt(hi);
    const br = b1 && b2 && b1 === b2 ? b1.label : [b1?.label, b2?.label].filter(Boolean).join(" / ");
    return `<tr class="${f.call && br.includes(f.call) ? "callrow" : ""}"><td>${c.c} °C</td><td>${c.f}</td><td class="dim">${c.lo}–${c.hi}</td><td>${esc(s)}${br ? ` <span class="dim">(${esc(br)})</span>` : ""}</td></tr>`;
  }).join("");
  $("tgroups").innerHTML = (f.tgroups || []).length ? "METAR T-group needed:<br>" + f.tgroups.map((t) => `${esc(t.bracket)}: ≥ ${t.needF} °F → <b>${t.tgroup}</b> (6-h max group ≥ 1${t.tgroup.slice(1)}; a 1-min ${t.oneMinC} °C reading confirms it)`).join("<br>") : "";

  // analogs
  const a = f.analogs;
  $("ana-h").textContent = a ? `${a.n} days · median ${a.median} · 10–90% ${a.p10}–${a.p90}` : "not enough matches";
  $("tb-ana").innerHTML = a ? a.top.map((d) => `<tr><td>${d.date}</td><td>${d.high}</td><td>${d.dir}</td><td>${d.rain}</td><td>${Math.round(d.dew)}</td></tr>`).join("") : "";

  // track record
  const rows = Object.entries(DATA.log || {}).sort().reverse().slice(0, 14);
  const cell = (s, act) => !s ? "—" : `<span class="${act == null ? "" : s.point === act ? "hit" : "miss"}">${s.point}</span> <span class="dim">${esc(s.call || "")}</span>`;
  $("tb-log").innerHTML = rows.map(([d, e]) => `<tr><td>${d}</td><td>${cell(e.first, e.actual)}</td><td>${cell(e.morning, e.actual)}</td><td>${cell(e.latest, e.actual)}</td><td class="dim">${esc(e.latest?.kalshi_peak || "")}</td><td><b>${e.actual ?? "—"}</b></td></tr>`).join("")
    || `<tr><td colspan="6" class="dim">Builds up as the scheduled job runs.</td></tr>`;

  // links (peak hour for soundings)
  const lat = 25.79, lon = -80.29, ev = f.kalshi?.event || "";
  $("links").innerHTML = [
    [`https://www.tropicaltidbits.com/analysis/models/sounding/?model=hrrr&lat=${lat}&lon=${lon}&mode=regular`, "HRRR sounding"],
    [`https://www.tropicaltidbits.com/analysis/models/sounding/?model=gfs&lat=${lat}&lon=${lon}&mode=regular`, "GFS sounding"],
    ["https://www.tropicaltidbits.com/analysis/models/?model=gfs&region=seus&pkg=T2m", "GFS SE US maps"],
    ["https://www.tropicaltidbits.com/analysis/models/?model=gfs&region=nhem&pkg=T850a", "GFS N. Hemisphere maps"],
    ["https://wethr.net/market/miami", "wethr Miami"],
    ["https://forecast.weather.gov/MapClick.php?lat=25.79&lon=-80.32", "NWS point forecast"],
    ["https://radar.weather.gov/station/kamx/standard", "Radar KAMX"],
    [`https://kalshi.com/markets/kxhighmia`, `Kalshi ${ev}`],
  ].map(([u, t]) => `<a href="${u}" target="_blank" rel="noopener">${esc(t)} ↗</a>`).join("");
}

function spark(series, f) {
  const cv = $("spark"), dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr; const g = cv.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
  if (!series.length) return;
  const css = getComputedStyle(document.documentElement);
  const ys = series.map((s) => s.f).concat([f.mean, f.mean + f.sd, f.floor ?? f.mean]);
  const ymin = Math.floor(Math.min(...ys) - 1), ymax = Math.ceil(Math.max(...ys) + 1);
  const X = (h) => 28 + (h / 24) * (W - 36), Y = (v) => 8 + (1 - (v - ymin) / (ymax - ymin)) * (H - 24);
  g.font = "10px IBM Plex Mono, monospace"; g.fillStyle = css.getPropertyValue("--dim");
  for (let v = ymin; v <= ymax; v += Math.max(1, Math.round((ymax - ymin) / 4))) { g.fillText(v, 2, Y(v) + 3); g.strokeStyle = css.getPropertyValue("--line"); g.beginPath(); g.moveTo(28, Y(v)); g.lineTo(W - 6, Y(v)); g.stroke(); }
  [0, 6, 12, 18].forEach((h) => g.fillText(h === 0 ? "12a" : h === 12 ? "12p" : h > 12 ? `${h - 12}p` : `${h}a`, X(h) - 6, H - 3));
  g.fillStyle = "rgba(46,211,198,.10)"; g.fillRect(28, Y(f.mean + f.sd), W - 34, Y(f.mean - f.sd) - Y(f.mean + f.sd));
  g.strokeStyle = css.getPropertyValue("--official"); g.setLineDash([4, 4]); g.beginPath(); g.moveTo(28, Y(f.mean)); g.lineTo(W - 6, Y(f.mean)); g.stroke(); g.setLineDash([]);
  g.strokeStyle = css.getPropertyValue("--pool"); g.lineWidth = 2; g.beginPath();
  series.forEach((s, i) => (i ? g.lineTo(X(s.h), Y(s.f)) : g.moveTo(X(s.h), Y(s.f)))); g.stroke();
  g.fillStyle = css.getPropertyValue("--official"); g.fillText(`forecast ${f.mean}`, W - 90, Y(f.mean) - 4);
}

document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => {
  DAY = b.dataset.day; try { localStorage.setItem("smia_fc_tab", DAY); } catch { /* ignore */ }
  if (DATA) render();
}));
tick(); setInterval(tick, 15e3);
load(); setInterval(load, 10 * 60e3);
