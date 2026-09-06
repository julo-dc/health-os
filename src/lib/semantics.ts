/**
 * The semantic layer: what every metric actually means.
 *
 * One source of truth, used twice. The UI reads it for plain-language
 * explanations, and every LLM prompt reads it so the model knows what a number
 * *is* — that TSB is a difference and can legitimately be negative, that
 * `nap_min` deliberately excludes the main sleep, that `strength_index` is a
 * running best rather than today's performance. Without this the model has only
 * a key name and a unit, and fills the gap by guessing.
 */

export type Semantic = {
  /** One sentence: what this measures. */
  what: string;
  /** Where the number comes from — device, derivation, or your own entry. */
  how: string;
  /** How to read a change in it. */
  read: string;
  /** What makes it unreliable or easy to misread. Omitted when there's nothing. */
  caveat?: string;
  /** Metric keys this is computed from — a correlation with these is arithmetic. */
  derivedFrom?: string[];
  /** Metric keys that commonly move with it, worth checking together. */
  relatedTo?: string[];
  /** A typical range for a reasonably fit adult, purely for orientation. */
  typical?: string;
};

export const SEMANTICS: Record<string, Semantic> = {
  /* ── body composition ───────────────────────────────────────────────── */
  weight_kg: {
    what: "Total body mass.",
    how: "Smart scale or a manual entry.",
    read: "Only the multi-week trend means anything. Day-to-day swings of 1–2kg are water, food volume and glycogen, not tissue.",
    caveat: "A single weigh-in is close to noise. Weigh at the same time of day, and read the 7-day average rather than today's number.",
    relatedTo: ["body_fat_pct", "lean_mass_kg", "fat_mass_kg", "calories_in"],
  },
  body_fat_pct: {
    what: "Proportion of body mass that is fat.",
    how: "Bioimpedance scale, calipers, or a manual entry.",
    read: "Falling body fat with stable weight is recomposition — the outcome most people actually want.",
    caveat: "Bioimpedance is strongly affected by hydration and can swing 2-3 points between mornings. Trust the direction over weeks, never a single reading.",
    relatedTo: ["weight_kg", "lean_mass_kg", "fat_mass_kg"],
  },
  lean_mass_kg: {
    what: "Fat-free mass: muscle, bone, organs and water.",
    how: "Computed as weight × (1 − body fat %).",
    read: "Holding or gaining this while fat mass falls is the definition of a successful recomp.",
    caveat: "Inherits every error in the body-fat measurement, so it is at least as noisy as that.",
    derivedFrom: ["weight_kg", "body_fat_pct"],
    relatedTo: ["fat_mass_kg", "training_volume_kg", "protein_g"],
  },
  fat_mass_kg: {
    what: "Absolute mass of body fat.",
    how: "Computed as weight × body fat %.",
    read: "The number to watch in a cut. Falling fat mass with flat lean mass beats a bigger drop on the scale.",
    derivedFrom: ["weight_kg", "body_fat_pct"],
    relatedTo: ["lean_mass_kg"],
  },

  /* ── cardio & recovery ──────────────────────────────────────────────── */
  resting_hr: {
    what: "Heart rate at complete rest, usually measured overnight.",
    how: "Wearable, computed across sleep.",
    read: "Lower generally means better aerobic fitness or better recovery. A rise of 5+ bpm sustained over several days often precedes illness, or signals accumulated fatigue, alcohol or poor sleep.",
    caveat: "Responds to alcohol, heat, late meals and stress as much as to training. Read it alongside HRV rather than alone.",
    typical: "48–65 bpm for a trained adult",
    relatedTo: ["hrv_ms", "sleep_hours", "readiness", "alcohol_units"],
  },
  hrv_ms: {
    what: "Heart rate variability — the variation between heartbeats, a proxy for autonomic recovery.",
    how: "Wearable, measured during sleep.",
    read: "Higher usually means better recovered. What matters is your own baseline and the size of the deviation from it, never comparison with another person.",
    caveat: "Extremely noisy day to day; a 7-day average is the honest unit. Absolute values differ hugely between people and devices, so only relative change is meaningful.",
    relatedTo: ["resting_hr", "sleep_hours", "readiness", "training_load", "alcohol_units"],
  },
  vo2max: {
    what: "Estimated maximum oxygen uptake — the standard measure of aerobic capacity.",
    how: "Estimated by the wearable from pace against heart rate during runs.",
    read: "Moves slowly. A change of 1–2 points over a couple of months is real progress.",
    caveat: "A device estimate, not a lab test. It reacts to how you ran as much as to your fitness, so it drifts when your training mix changes.",
    relatedTo: ["ctl", "resting_hr"],
  },
  spo2_pct: {
    what: "Blood oxygen saturation during sleep.",
    how: "Wearable pulse oximetry.",
    read: "Normally stable and high. A persistent drop is worth raising with a doctor rather than self-interpreting.",
    caveat: "Wrist oximetry is easily disturbed by wrist position and fit; single low nights are usually artefacts.",
    typical: "95–99%",
  },
  respiratory_rate: {
    what: "Breaths per minute during sleep.",
    how: "Wearable.",
    read: "Very stable per person. A rise of 1–2 breaths sustained across nights often accompanies illness onset or hard training.",
    typical: "12–18 breaths/min",
    relatedTo: ["resting_hr", "hrv_ms"],
  },

  /* ── sleep ──────────────────────────────────────────────────────────── */
  sleep_hours: {
    what: "Time actually asleep during the main sleep, excluding time awake in bed.",
    how: "Wearable sleep staging. Naps are excluded and counted separately.",
    read: "The single most reliable lever over next-day recovery, focus and appetite.",
    caveat: "A night is credited to the morning you woke, so Monday's figure is the night of Sunday into Monday.",
    relatedTo: ["sleep_efficiency", "hrv_ms", "resting_hr", "readiness", "nap_min", "focus_score"],
    typical: "7–9 hours",
  },
  sleep_efficiency: {
    what: "Share of time in bed that was spent asleep.",
    how: "Minutes asleep divided by the length of the sleep period.",
    read: "Low efficiency with adequate time in bed points at sleep quality — alcohol, late food, a warm room, stress.",
    typical: "85–95%",
    relatedTo: ["sleep_hours", "sleep_awake_min", "alcohol_units"],
  },
  deep_sleep_min: {
    what: "Minutes in deep (slow-wave) sleep, most associated with physical recovery.",
    how: "Wearable stage estimate.",
    read: "Tends to rise with training load and fall with alcohol or late eating.",
    caveat: "Consumer stage detection is approximate. Treat the trend as real and any single night as indicative only.",
    relatedTo: ["sleep_hours", "hrv_ms", "training_load"],
  },
  rem_sleep_min: {
    what: "Minutes in REM sleep, most associated with cognitive consolidation and mood.",
    how: "Wearable stage estimate.",
    read: "Suppressed by alcohol and by short sleep, since REM concentrates in the later part of the night.",
    caveat: "Same estimation caveat as deep sleep.",
    relatedTo: ["sleep_hours", "mood", "focus_score"],
  },
  sleep_start_hour: {
    what: "Bedtime, expressed as hours around midnight in local time.",
    how: "Start of the main sleep. Negative means before midnight — −0.5 is 23:30, 1.0 is 01:00.",
    read: "Consistency matters more than the absolute hour. A wandering bedtime disrupts recovery even when total sleep holds.",
    caveat: "The negative-hours convention exists so bedtimes either side of midnight average sensibly; it is not an error.",
    relatedTo: ["sleep_hours", "sleep_efficiency"],
  },
  nap_min: {
    what: "Daytime sleep, excluding the main sleep.",
    how: "Any sleep session that isn't the main one and doesn't overlap it.",
    read: "Useful recovery, but heavy napping alongside poor night sleep usually points at insufficient or fragmented nights.",
    relatedTo: ["sleep_hours"],
  },

  /* ── activity & training ────────────────────────────────────────────── */
  steps: {
    what: "Daily step count.",
    how: "Wearable.",
    read: "The best available proxy for non-exercise activity, which drives a surprising share of daily energy expenditure.",
    caveat: "Today's figure is incomplete until the day ends — never compare a part-day against full days.",
    relatedTo: ["distance_km", "calories_out", "sedentary_min"],
  },
  training_load: {
    what: "Session strain in arbitrary units, aggregated per day.",
    how: "Banister TRIMP from heart rate where available (time weighted exponentially by intensity), otherwise duration × RPE, otherwise duration alone.",
    read: "The input the whole fitness/fatigue model is built on.",
    caveat: "Sessions without heart rate are estimated more crudely, so a day of pure strength work is less precisely measured than a run.",
    relatedTo: ["ctl", "atl", "tsb", "workout_min", "training_volume_kg"],
  },
  ctl: {
    what: "Chronic training load — 'fitness'. A 42-day exponentially weighted average of daily load.",
    how: "Derived from training_load.",
    read: "What you have built. It rises slowly with consistency and decays within weeks of stopping.",
    caveat: "A number in arbitrary units — only its trajectory means anything, and it is not comparable to anyone else's.",
    derivedFrom: ["training_load"],
    relatedTo: ["atl", "tsb", "acwr"],
  },
  atl: {
    what: "Acute training load — 'fatigue'. A 7-day exponentially weighted average of daily load.",
    how: "Derived from training_load.",
    read: "What you are currently carrying. It should exceed fitness during a build block and fall below it in a taper.",
    derivedFrom: ["training_load"],
    relatedTo: ["ctl", "tsb"],
  },
  tsb: {
    what: "Training stress balance — 'form'. Fitness minus fatigue.",
    how: "CTL − ATL, measured before the day's session lands.",
    read: "Negative means you are carrying fatigue, which is where adaptation happens. Strongly negative (below −25) means buried. Strongly positive (above +20) means fresh but detraining.",
    caveat: "Negative is normal and usually desirable mid-block. It is not a problem to be fixed.",
    derivedFrom: ["ctl", "atl"],
    relatedTo: ["readiness"],
  },
  acwr: {
    what: "Acute-to-chronic workload ratio: recent load against established load.",
    how: "ATL ÷ CTL.",
    read: "Around 0.8–1.3 is steady progression. Sustained values above 1.5 are where injury risk climbs sharply in the sports-science literature.",
    caveat: "Unstable when chronic load is low — early in training, or after a layoff, the ratio spikes on any normal session.",
    derivedFrom: ["atl", "ctl"],
  },
  readiness: {
    what: "A composite 0–100 estimate of how recovered you are today.",
    how: "Weighted blend of HRV (35%), resting HR (30%), sleep (25%) and form (10%), each scored against your own trailing 60-day baseline.",
    read: "50 is your personal normal, not a population average. 70+ is a genuinely good day; below 35 suggests backing off.",
    caveat: "A composite of its own inputs — correlating it against HRV or sleep is arithmetic, not insight.",
    derivedFrom: ["hrv_ms", "resting_hr", "sleep_hours", "tsb"],
  },

  /* ── strength ───────────────────────────────────────────────────────── */
  training_volume_kg: {
    what: "Total weight moved in a lifting session: the sum of weight × reps across every set.",
    how: "Computed from set-level rows in a strength log.",
    read: "The main driver of hypertrophy. Rising volume at a steady effort means you are progressing.",
    caveat: "Rises with junk sets as easily as with real work, and falls during a deliberate deload. Read it beside strength_index rather than alone.",
    relatedTo: ["sets_count", "hard_sets", "strength_index", "lean_mass_kg"],
  },
  hard_sets: {
    what: "Sets taken at RPE 7 or above — close enough to failure to drive adaptation.",
    how: "Counted from logged RPE values.",
    read: "Usually predicts muscle growth better than total volume does.",
    caveat: "Only as good as your RPE logging; blank RPE counts as not hard.",
    relatedTo: ["training_volume_kg", "sets_count"],
  },
  strength_index: {
    what: "Summed estimated one-rep max across your six most-trained lifts.",
    how: "Epley estimate — weight × (1 + reps/30) — using sets of 1–12 reps, carried forward as a running best per lift.",
    read: "The clearest answer to 'am I keeping strength while losing fat?'. It should hold or rise through a cut.",
    caveat: "A running best, so it does not fall on an easy day — it reflects demonstrated capability, not today's performance. It only moves when you train a main lift near your limit.",
    derivedFrom: ["training_volume_kg"],
    relatedTo: ["lean_mass_kg", "training_volume_kg"],
  },
  top_set_kg: {
    what: "Heaviest single set loaded on a given day.",
    how: "Maximum weight across the day's sets.",
    read: "A quick read on whether you are working heavy or accumulating volume.",
    caveat: "Ignores reps entirely — 100kg×1 and 100kg×10 look identical here.",
  },

  /* ── nutrition ──────────────────────────────────────────────────────── */
  calories_in: {
    what: "Energy consumed.",
    how: "Logged manually or imported from a nutrition app.",
    read: "The dominant lever on weight direction over weeks.",
    caveat: "Self-logging is systematically under-reported, often by 20% or more. Treat changes in the number as more trustworthy than its absolute level.",
    relatedTo: ["calories_out", "weight_kg", "protein_g"],
  },
  protein_g: {
    what: "Protein consumed.",
    how: "Logged manually or imported.",
    read: "The nutritional variable that most protects lean mass during a calorie deficit.",
    relatedTo: ["lean_mass_kg", "training_volume_kg"],
  },
  alcohol_units: {
    what: "Alcohol consumed.",
    how: "Logged manually.",
    read: "One of the most visible single-day effects in this whole dataset — typically suppresses HRV and deep sleep and raises resting HR that night.",
    relatedTo: ["hrv_ms", "resting_hr", "sleep_efficiency", "deep_sleep_min"],
  },

  /* ── work & cognition ───────────────────────────────────────────────── */
  deep_work_hours: {
    what: "Hours of focused, undistracted work.",
    how: "Logged manually.",
    read: "Usually the real input behind business progress — output metrics like revenue lag it by weeks.",
    caveat: "Self-reported, so consistency of definition matters more than precision. Decide what counts and stick to it.",
    relatedTo: ["focus_score", "sleep_hours", "revenue"],
  },
  focus_score: {
    what: "Self-rated focus for the day, 0–10.",
    how: "Logged manually.",
    read: "Subjective, but it often tracks sleep and recovery closely enough to reveal the link.",
    relatedTo: ["sleep_hours", "hrv_ms", "deep_work_hours"],
  },
  revenue: {
    what: "Money earned.",
    how: "Logged manually or imported.",
    read: "A lagging outcome. When it stalls, look at the inputs — deep work, calls, shipping — several weeks back.",
    relatedTo: ["deep_work_hours", "mrr"],
  },
  mrr: {
    what: "Monthly recurring revenue.",
    how: "Logged manually.",
    read: "A standing value, not a daily total — the last recorded figure is the current one.",
    relatedTo: ["revenue", "customers"],
  },
  mood: { what: "Self-rated mood, 0–10.", how: "Logged manually.", read: "Most useful as context for interpreting the objective metrics around it.", relatedTo: ["sleep_hours", "energy", "stress"] },
  energy: { what: "Self-rated energy, 0–10.", how: "Logged manually.", read: "Often tracks recovery more closely than any single device metric.", relatedTo: ["readiness", "sleep_hours"] },
  stress: { what: "Self-rated stress, 0–10.", how: "Logged manually.", read: "Sustained high stress usually shows up in HRV and resting HR within days.", relatedTo: ["hrv_ms", "resting_hr", "sleep_efficiency"] },

  /* ── completing the vocabulary ──────────────────────────────────────── */
  waist_cm: {
    what: "Waist circumference, measured at the navel.",
    how: "Tape measure, entered manually.",
    read: "Often a better recomp signal than the scale — it moves when visceral fat does, even in a week the weight holds.",
    caveat: "Measure at the same point, at the same time of day, without holding your breath in.",
    relatedTo: ["body_fat_pct", "weight_kg"],
  },
  height_cm: { what: "Standing height.", how: "Entered once, or read from your profile.", read: "Fixed. Used to contextualise weight and body composition." },
  avg_hr: {
    what: "Average heart rate across the whole day, waking and sleeping.",
    how: "Wearable.",
    read: "A blunt aggregate — a hard training day and a stressful desk day can look identical.",
    caveat: "Resting HR is the far more interpretable number; use this only for coarse comparison.",
    relatedTo: ["resting_hr", "max_hr_daily"],
  },
  max_hr_daily: {
    what: "Highest heart rate reached on a given day.",
    how: "Wearable.",
    read: "On training days it reflects session intensity. The highest value across months is a decent estimate of your true maximum, which the training-load model uses.",
    caveat: "A single bad sensor reading can spike this; one implausible value is usually an artefact.",
    relatedTo: ["training_load", "avg_hr"],
  },
  min_hr_daily: { what: "Lowest heart rate reached, almost always during deep sleep.", how: "Wearable.", read: "Tracks closely with resting HR and improves with aerobic fitness.", relatedTo: ["resting_hr"] },
  hrv_deep_ms: {
    what: "Heart rate variability measured specifically during deep sleep.",
    how: "Wearable.",
    read: "Less contaminated by movement and position than whole-night HRV, so a cleaner recovery signal when available.",
    relatedTo: ["hrv_ms", "deep_sleep_min"],
  },
  sleep_awake_min: {
    what: "Minutes spent awake after first falling asleep.",
    how: "Wearable staging of the main sleep.",
    read: "Rising fragmentation with unchanged time in bed points at sleep quality — alcohol, heat, stress, a late meal.",
    relatedTo: ["sleep_efficiency", "sleep_hours"],
  },
  distance_km: { what: "Distance covered across the day, walking and running.", how: "Wearable, from stride and GPS.", read: "Moves with steps; useful mainly for endurance goals.", relatedTo: ["steps", "workout_min"] },
  floors: { what: "Flights of stairs climbed.", how: "Wearable barometer.", read: "A rough proxy for incidental intensity.", caveat: "Pressure changes and lifts both confuse it; treat large values sceptically.", relatedTo: ["steps"] },
  active_zone_min: {
    what: "Minutes spent in a raised heart-rate zone, weighted so vigorous minutes count double.",
    how: "Wearable, from heart rate against your zones.",
    read: "Closer to public-health guidance than steps, because it weights intensity rather than counting movement.",
    typical: "150+ per week is the common guideline",
    relatedTo: ["moderate_vigorous_min", "training_load"],
  },
  active_minutes: { what: "Minutes at any activity level above sedentary.", how: "Wearable.", read: "Includes light activity, so it rises with a long slow walk as easily as with training.", caveat: "Not intensity-weighted — read active zone minutes for that.", relatedTo: ["active_zone_min", "steps"] },
  moderate_vigorous_min: { what: "Active minutes excluding the lightest tier.", how: "Wearable, summed across moderate and vigorous levels.", read: "The portion of your activity that actually drives cardiovascular adaptation.", relatedTo: ["active_zone_min"] },
  sedentary_min: { what: "Minutes spent inactive while awake.", how: "Wearable.", read: "Long sedentary blocks carry health costs somewhat independent of whether you train.", caveat: "Desk work inflates this regardless of how hard you trained that day.", relatedTo: ["steps", "deep_work_hours"] },
  calories_out: { what: "Total energy burned, resting metabolism included.", how: "Wearable estimate.", read: "Compare against calories eaten for the energy balance driving weight change.", caveat: "A model, not a measurement, and typically accurate only to within 10-20%.", relatedTo: ["calories_in", "active_calories", "weight_kg"] },
  active_calories: { what: "Energy burned by activity, excluding resting metabolism.", how: "Wearable estimate.", read: "The part of expenditure you actually control day to day.", derivedFrom: ["calories_out"], relatedTo: ["training_load"] },
  workout_min: { what: "Total minutes of deliberate exercise.", how: "Summed across recorded sessions.", read: "Volume, not intensity — two hours of easy walking and two hours of intervals look the same here.", relatedTo: ["training_load", "ctl"] },
  sets_count: { what: "Total working sets performed.", how: "Counted from a set-level strength log.", read: "A crude volume proxy. Hard sets is the better predictor.", relatedTo: ["hard_sets", "training_volume_kg"] },
  reps_total: { what: "Total repetitions across every set.", how: "Summed from a strength log.", read: "Rises with lighter, higher-rep work and falls with heavy low-rep work, independent of effort.", relatedTo: ["training_volume_kg"] },
  carbs_g: { what: "Carbohydrate consumed.", how: "Logged or imported.", read: "Drives training fuel and glycogen, which is also the main cause of day-to-day scale swings.", relatedTo: ["calories_in", "weight_kg"] },
  fat_g: { what: "Dietary fat consumed.", how: "Logged or imported.", read: "Matters mainly through its calorie contribution and for hormonal health at very low intakes.", relatedTo: ["calories_in"] },
  water_l: { what: "Water drunk.", how: "Logged manually.", read: "Affects scale weight and perceived energy considerably more than most people expect.", relatedTo: ["weight_kg"] },
  customers: { what: "Total customers.", how: "Logged manually.", read: "A standing value — the most recent figure is the current one, not a daily total.", relatedTo: ["mrr", "revenue"] },
  sales_calls: { what: "Sales conversations held.", how: "Logged manually.", read: "A leading input: it moves weeks before revenue does.", relatedTo: ["revenue", "deep_work_hours"] },
  shipped_items: { what: "Things shipped — features, posts, deliverables.", how: "Logged manually.", read: "Output rather than time spent, which usually predicts business progress better than hours do.", relatedTo: ["deep_work_hours", "revenue"] },
  meditation_min: { what: "Time spent meditating.", how: "Logged manually.", read: "Where an effect shows up at all, it usually appears in stress and HRV rather than in performance.", relatedTo: ["stress", "hrv_ms"] },
  reading_min: { what: "Time spent reading.", how: "Logged manually.", read: "Track it if learning is part of the goal; otherwise it is context for how you spent the day.", relatedTo: ["screen_time_h"] },
  screen_time_h: { what: "Time on screens.", how: "Logged manually or imported from device reporting.", read: "Evening screen time in particular tends to associate with later bedtimes and worse sleep quality.", relatedTo: ["sleep_start_hour", "sleep_efficiency"] },
};

/** Statistical vocabulary, explained once and reused everywhere. */
export const STAT_TERMS: Record<string, { what: string; read: string }> = {
  trend: {
    what: "Direction of travel over the window, from the Theil-Sen slope — the median of every pairwise slope in the series.",
    read: "Robust to outliers, unlike a least-squares line: a couple of wild readings can't tilt it.",
  },
  significance: {
    what: "Mann-Kendall p-value: the probability of seeing a pattern this consistent if nothing were really changing.",
    read: "Below 0.05 the trend is unlikely to be chance. Above it, treat the movement as noise however convincing the line looks.",
  },
  coverage: {
    what: "Share of days in the window that actually have a reading.",
    read: "Below about 50%, every conclusion here is weak. It is the first thing to check when a result surprises you.",
  },
  confidence: {
    what: "A combined read on how much data supports a conclusion — both the number of readings and how much of the period they cover.",
    read: "Low confidence doesn't mean the finding is wrong, only that it isn't yet established.",
  },
  forecast: {
    what: "A damped-trend model fitted to your own history, then simulated 800 times by resampling its own errors.",
    read: "The shaded bands are where the value plausibly lands, not a promise. The band widens with the horizon because uncertainty compounds.",
  },
  probability: {
    what: "Share of those 800 simulations that reached the target by the deadline.",
    read: "It assumes you carry on roughly as you have been. Changing behaviour is exactly how you beat a low number.",
  },
  change_point: {
    what: "A date where the average level of a metric shifted, found by testing every possible split point.",
    read: "Only shifts that are both statistically significant and large enough to matter are shown. They usually correspond to something real you can name.",
  },
  driver: {
    what: "Ridge regression of a target metric on your other metrics, each at its most predictive lag.",
    read: "Association, not causation. Inputs that move together share credit, so read the set rather than any single coefficient.",
  },
  goal_index: {
    what: "Weighted average of progress across every goal target, 0–100.",
    read: "Only meaningful next to the expected figure — 40% is good at the halfway mark and poor at three-quarters.",
  },
  pace: {
    what: "Progress divided by the fraction of time elapsed.",
    read: "1.0× is exactly on schedule. Below 0.85× you are behind; below 0.5× the goal is at risk.",
  },
};

export function semanticsFor(key: string): Semantic | null {
  return SEMANTICS[key] ?? null;
}

/** Compact, token-efficient rendering of the dictionary for an LLM prompt. */
export function semanticsBrief(keys: string[]): string {
  const lines: string[] = [];
  for (const k of keys) {
    const s = SEMANTICS[k];
    if (!s) continue;
    const bits = [`${k}: ${s.what} ${s.read}`];
    if (s.caveat) bits.push(`CAVEAT: ${s.caveat}`);
    if (s.derivedFrom?.length) bits.push(`DERIVED FROM ${s.derivedFrom.join(", ")} — correlating against those is arithmetic, not a finding.`);
    lines.push(bits.join(" "));
  }
  return lines.join("\n");
}
