# KMIA · Miami Intl PWS polygon nowcaster

Browser-only dashboard for calling the KMIA daily high. A Claude-drawn polygon over
western Miami-Dade captures every public **Ambient Weather** PWS inside it, QC's the
pool, averages it, and tracks it live against the **KMIA ASOS** (METAR via
aviationweather.gov) and a ring of five metro fields.

Three files, no build step, no keys: `index.html` · `app.js` · `styles.css`.

## What it does

- **Polygon capture** — every public AW station inside the polygon joins the pool.
  Grey dots on the map are nearby stations currently outside it. Reshape the zone by
  editing `CONFIG.polygon` in `app.js` (`[lon, lat]` points); the map and pool
  re-filter automatically. The polygon deliberately excludes Biscayne Bay, the beach
  barrier island and the Everglades fringe — different air mass from the field.
- **Automatic bad-reading drops** — per poll, a station is dropped for: stale (>40 min),
  out of range (30–110 °F), gross Δ (>9 °F from a fresh KMIA ob), flatlining while the
  pool moves, or robust MAD outlier vs the pool median. Every drop shows its reason in
  the manifest and on the map.
- **Hourly health check** — sweeps ~24 h of per-station history against the KMIA
  series. Stable bias is **corrected, not dropped** (capped ±6 °F); noisy, absurdly
  offset, or chronically flat stations are **quarantined**. Manual `block` / `allow`
  overrides per station in the manifest.
- **Averaging** — mean, median, trimmed mean, bias-corrected mean (the headline
  number), spread, **p90 hot edge**, and hottest station.
- **Rate of rise/fall** — °F/h over 15 / 30 / 60 min, plus the METAR's own trend.
- **Δ vs METAR** — bias-corrected pool minus the latest KMIA ob, with Δ p90 under it.
- **Sea-breeze state** — KMIA wind in the 060–170° sector at ≥7 kt reads **BREEZE IN**
  (cap risk, high likely set); otherwise the high window is open. BREEZE IN at ≥10 kt
  sustained or gusting ≥14 raises the **⚠ gust-mix burst** flag: settlement runs off
  1-minute data, and on gusty breeze-in afternoons the ASOS can print above the pool
  mean — that's what the p90 line and the flag are for.
- **Breeze front (east − west cohorts)** — stations east of `CONFIG.splitLon` feel the
  breeze first. East cooling while west holds = the front is crossing toward the field.
- **Metro METAR ring (KMIA only)** — KFLL · KHWO · KOPF · KTMB · KHST, each with temp,
  Δ vs KMIA, and wind (aqua when onshore), plus badges on the map when zoomed out.

## Deploy (GitHub Pages)

1. Commit `index.html`, `app.js`, `styles.css` to the repo root on `main`
   (commit **directly to main** — watch the branch dropdown in the commit dialog).
2. Settings → Pages → Deploy from a branch → `main` / `(root)`.
3. Open the bare repo URL after the Pages action finishes; hard-refresh.

If any old files are still in the repo (`wrangler.jsonc`, `_worker.js`, `.assetsignore`,
a `functions/` folder), delete them — this build doesn't use them.

## Data notes

- **Ambient Weather** — public per-PWS JSON via the `lightning.ambientweather.net`
  bounding-box endpoint; the polygon filter runs client-side.
- **METAR** — `aviationweather.gov/api/data/metar`, one call for all six fields.
  Hourly + specials; the CLI daily max settles off 1-minute data, so brief bursts can
  print above the hourly METAR max.
- **History** — pool/health series persist in `localStorage` (per browser, ~26 h).
  Keep a tab open through the afternoon for full curves; bias/health quality improves
  after a couple of hours of history.

## Tuning

Everything lives at the top of `app.js`: `CONFIG.polygon`, `CONFIG.splitLon`,
`CONFIG.qc` (drop thresholds), `CONFIG.health` (quarantine/bias rules),
`CONFIG.breeze` (onshore sector + burst rules), `CONFIG.ring`.
