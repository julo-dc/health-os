# Vector

Your health, training and work data, pointed at one goal — and an honest answer to
*"am I actually getting there?"*

Vector ingests Fitbit data (via the Google Health API), CSV exports, manual entries
and photos, then runs a statistical engine over all of it against a goal you set in
plain language. Every claim it makes carries a significance test and a confidence
level, so you can tell a real trend from a fortnight of noise.

---

## What it does

**Goal Progress Index** — one 0–100 score for the goal, shown against where a linear
pace would have you. Weighted across every target, with per-target status
(ahead / on track / behind / at risk).

**Forecasting** — Holt damped-trend model fitted by grid search, simulated 800 times
against bootstrapped residuals from your own data. Gives a fan chart and a real
probability of hitting each target by its deadline. Damping matters: an undamped
line happily predicts you weigh 40kg by Christmas.

**Trend testing** — Mann–Kendall with tie correction plus a Theil–Sen slope, next to
ordinary least squares. Non-parametric tests are the ones to trust for noisy
biometrics: a couple of wild readings can't manufacture a trend the way they can
with a least-squares line.

**Change-point detection** — binary segmentation on the Welch t-statistic, gated on
both significance and effect size. Surfaces "something changed on 27 June" without
you having to remember what.

**Driver analysis** — ridge regression on standardised inputs, each at its most
predictive lag, answering *what actually moves this metric?* Ridge rather than OLS
because health inputs are heavily collinear. Reports adjusted R², drops predictors
it doesn't have the rows to support, and excludes metrics that are derived from the
target (correlating fat mass against body-fat % is arithmetic, not insight).

**Training load** — Banister impulse-response model. TRIMP from heart rate where
available, else session-RPE. Yields CTL (fitness), ATL (fatigue), TSB (form),
acute:chronic workload ratio, and Foster monotony/strain.

**Body recomposition** — splits weight into lean and fat mass and scores the thing
the scale can't tell you: of the weight you moved, how much came from fat.

**Readiness** — daily 0–100 from HRV, resting HR, sleep and form, each scored against
*your own* 60-day baseline rather than population norms.

**Anomaly detection** — robust z-scores (median/MAD) against a trailing baseline, so
one bad sensor reading doesn't inflate the variance and hide real signal.

**AI coaching briefing** — the model receives *computed statistics only*, never raw
series: trends with p-values, projections with probabilities, drivers with
coefficients. That keeps it doing what it's good at (interpreting and prioritising)
and out of what it's bad at (arithmetic over long number lists), so every figure it
cites traces back to a computed value.

**Photo intelligence** — progress photos get a qualitative body-composition read;
screenshots of scales, apps or whiteboards get their numbers extracted straight into
your metric store.

**LLM-read CSV import** — the parser reads the file; the model interprets it. It identifies
the export's origin, decides whether it's one-row-per-day or one-row-per-workout, maps each
column onto your metric vocabulary, and infers units from both header wording and the
*magnitude of the values* — a "Distance" column around 10,000 is metres, a "Weight" around 185
is pounds. It proposes new metrics, with sensible units and aggregation, for concepts you
don't track yet. Three guardrails: it may only choose keys from your vocabulary or explicitly
declare a new one, it may only pick conversions from a fixed enum (never arbitrary
expressions), and every proposal is checked against plausible ranges for the target metric
before you see it. Nothing is written until you approve the reading.

**Data health** — coverage and staleness per metric, everywhere. Analytics on a
40%-covered series is a guess, and the app says so instead of pretending otherwise.

---

## Setup

### 1. Database

Any Postgres works. [Neon](https://neon.tech) has a free tier and suits serverless well.

```bash
DATABASE_URL=postgres://user:pass@host/db?sslmode=require
```

The schema creates itself on first request — no migration step needed. To apply it
up front: `npm run migrate`.

### 2. Google OAuth + Health API

One consent covers both sign-in and health data.

1. In [Google Cloud Console](https://console.cloud.google.com), create a project.
2. Enable the **Google Health API**.
3. **APIs & Services → Credentials → Create OAuth client ID → Web application**.
4. Add your redirect URI, exactly matching `OAUTH_REDIRECT_URI`:
   - `http://localhost:3000/api/auth/callback` for local
   - `https://your-app.vercel.app/api/auth/callback` for production
5. On the **Data Access** page, add these scopes (search "Google Health API"):
   `googlehealth.activity_and_fitness.readonly`, `health_metrics_and_measurements.readonly`,
   `sleep.readonly`, `nutrition.readonly`, `profile.readonly`.
6. Add yourself as a test user while the app is unverified.

> **On Google Fit:** the older Google Fit REST API closed to new signups in May 2024
> and sunsets at the end of 2026. The Google Health API is its cloud successor and is
> what now serves Fitbit data — that's what this app targets.

### 3. OpenRouter

Get a key at [openrouter.ai](https://openrouter.ai/keys). Optional — every statistical
feature works without one; only the written interpretation needs it.

```bash
OPENROUTER_API_KEY=sk-or-...
OPENROUTER_MODEL=anthropic/claude-sonnet-4.5
```

### 4. Environment

```bash
cp .env.example .env.local
# fill it in, then:
openssl rand -base64 32     # -> SESSION_SECRET
```

`ALLOWED_EMAILS` is the entire access-control model: only listed addresses can sign
in. Set it to your own address.

### 5. Run

```bash
npm install
npm run dev
```

Want to see it working before connecting anything? Seed six months of fabricated
demo data against a throwaway database:

```bash
SEED_DEMO_EMAIL=you@example.com npm run seed
```

---

## Deploying to Vercel

```bash
vercel
```

Then set every variable from `.env.example` in **Project → Settings → Environment
Variables**, updating `OAUTH_REDIRECT_URI` to your production URL and adding that
same URL to the Google Cloud credential. Set `CRON_SECRET` to enable the nightly
recompute in `vercel.json`.

---

## Getting data in

| Source | How |
|---|---|
| Fitbit / Google | **Data → Sync now.** Pulls sleep, HRV, resting HR, SpO2, respiratory rate, steps, distance, weight, body fat, active zone minutes, calories, VO2 max and workouts. |
| Any CSV | **Data → Import.** The file is read by an LLM that works out what it is, what each column means and which units it's in — then you review that reading and correct anything before a row is stored. See below. |
| Manual | **Log.** Goal metrics appear first. Create custom metrics for anything you track. |
| Photos | **Photos.** Progress shots or screenshots of scales/apps/dashboards. |

A manual entry always beats a synced value for the same day
(`manual > csv > google_health > photo > derived`).

### How the CSV reading works

1. The file is parsed deterministically — RFC4180, delimiter sniffing, EU and US number and
   date formats. An LLM never sees more than the headers and eight sample rows.
2. The model returns a plan: file kind, likely source, a per-column mapping with a unit
   conversion, a confidence, and one line of reasoning naming the evidence it used.
3. That plan is sanitised — unknown metric keys and unknown transforms are dropped — then every
   column's transformed sample values are range-checked against what the target metric can
   plausibly be. A column that lands outside gets its confidence dropped and a warning
   naming the conversion that would fix it.
4. You review it in the UI, change anything, and only then does it import.

Without an `OPENROUTER_API_KEY` this degrades to header-name matching and tells you it has
done so, rather than presenting a weak guess as a confident reading.

---

## How it's built

```
src/
  lib/
    db.ts               Postgres schema, lazily connected
    metric-meta.ts      Pure vocabulary + date helpers (client-safe)
    metrics.ts          Series read/write over the tidy long-format store
    auth.ts             Google OAuth, token refresh, JWT sessions
    googleHealth.ts     Google Health API client (rollup + list + sleep + exercise)
    openrouter.ts       LLM client, degrades gracefully with no key
    csv.ts              RFC4180 parser, type sniffing, header auto-mapping
    derive.ts           Recomputes everything that's a function of something else
    report.ts           Assembles the full dashboard analysis
    analytics/
      stats.ts          Descriptives, correlation, OLS, Welch, Cohen's d
      trend.ts          Smoothing, Mann-Kendall, Theil-Sen, change points, anomalies
      forecast.ts       Holt damped trend + Monte Carlo projection
      drivers.ts        Lagged correlation, ridge regression, behaviour splits
      load.ts           TRIMP, CTL/ATL/TSB, readiness, body composition
      goal.ts           Progress, pacing, status, the Goal Progress Index
```

Every metric, whatever its source, lands in one tidy long-format table as
`(date, metric_key, value, source)`. That single decision is why the analytics engine
never has to know where a number came from, and why adding a source is just a parser.

Charts are hand-rolled SVG — no charting library — against a colourblind-validated
palette, with crosshair tooltips, a legend whenever there's more than one series, and
light/dark themes that are each chosen rather than auto-flipped.

---

## A note on the numbers

Correlations here are associations in your own data, not proof of cause. Lags help —
"yesterday's sleep against today's focus" at least rules out the reverse direction in
time — but inputs that move together share credit, and the app says so where it
matters. Trends that don't clear significance are labelled as noise rather than
dressed up as insight. Visual body-fat estimates from photos are wide ranges, never a
number. None of this is medical advice.

---

## Known friction

This project lives in an iCloud Drive folder. iCloud syncs `node_modules/` and
`.next/`, which is slow and occasionally creates duplicate `"file 2.ts"` copies that
break the TypeScript build. If you hit that:

```bash
find .next node_modules -name "* [0-9].*" -delete
```

Moving the project to a non-synced location (`~/Developer/vector`) avoids it entirely.
