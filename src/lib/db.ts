import postgres from "postgres";

declare global {
  // eslint-disable-next-line no-var
  var __sql: ReturnType<typeof postgres> | undefined;
}

function connect() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
  return postgres(url, {
    ssl: url.includes("localhost") || url.includes("127.0.0.1") ? false : "require",
    max: 4,
    idle_timeout: 20,
    prepare: false, // safe behind PgBouncer / Neon pooler
    // CREATE TABLE IF NOT EXISTS emits an "already exists, skipping" notice on
    // every boot. Dropping those keeps genuine warnings visible in the logs.
    onnotice: (n) => {
      if (n.code !== "42P07" && n.code !== "42P06" && n.code !== "42701") console.warn("[pg]", n.message);
    },
  });
}

/**
 * Lazily-connected client.
 *
 * `postgres()` opens configuration eagerly, which would run during `next build`
 * (where DATABASE_URL is legitimately absent) and fail the build. The proxy
 * defers the connection to the first actual query, and reuses a single client
 * across hot reloads in development.
 */
let _sql: ReturnType<typeof postgres> | undefined;
function client() {
  if (!_sql) {
    _sql = global.__sql ?? connect();
    if (process.env.NODE_ENV !== "production") global.__sql = _sql;
  }
  return _sql;
}

export const sql = new Proxy(function () {} as unknown as ReturnType<typeof postgres>, {
  apply: (_t, _this, args: unknown[]) => (client() as (...a: unknown[]) => unknown)(...args),
  get: (_t, prop) => Reflect.get(client() as object, prop),
}) as ReturnType<typeof postgres>;

/** Idempotent schema creation. Safe to run on every boot. */
export async function migrate() {
  await sql.unsafe(`
  CREATE TABLE IF NOT EXISTS users (
    id           serial PRIMARY KEY,
    email        text UNIQUE NOT NULL,
    name         text,
    picture      text,
    created_at   timestamptz DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS oauth_tokens (
    user_id       int REFERENCES users(id) ON DELETE CASCADE,
    provider      text NOT NULL,
    access_token  text,
    refresh_token text,
    expires_at    timestamptz,
    scope         text,
    updated_at    timestamptz DEFAULT now(),
    PRIMARY KEY (user_id, provider)
  );

  ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS refresh_issued_at timestamptz;

  CREATE TABLE IF NOT EXISTS metric_defs (
    id               serial PRIMARY KEY,
    user_id          int REFERENCES users(id) ON DELETE CASCADE,
    key              text NOT NULL,
    label            text NOT NULL,
    unit             text,
    category         text DEFAULT 'custom',
    higher_is_better boolean,
    agg              text DEFAULT 'mean',
    precision        int DEFAULT 1,
    is_custom        boolean DEFAULT false,
    UNIQUE (user_id, key)
  );

  CREATE TABLE IF NOT EXISTS metrics (
    id         bigserial PRIMARY KEY,
    user_id    int REFERENCES users(id) ON DELETE CASCADE,
    date       date NOT NULL,
    metric_key text NOT NULL,
    value      double precision NOT NULL,
    source     text NOT NULL DEFAULT 'manual',
    meta       jsonb,
    UNIQUE (user_id, date, metric_key, source)
  );
  CREATE INDEX IF NOT EXISTS metrics_lookup ON metrics (user_id, metric_key, date);

  CREATE TABLE IF NOT EXISTS workouts (
    id           bigserial PRIMARY KEY,
    user_id      int REFERENCES users(id) ON DELETE CASCADE,
    start_time   timestamptz,
    date         date NOT NULL,
    type         text,
    name         text,
    duration_min double precision,
    distance_km  double precision,
    avg_hr       double precision,
    max_hr       double precision,
    calories     double precision,
    elevation_m  double precision,
    rpe          double precision,
    load         double precision,
    source       text DEFAULT 'manual',
    external_id  text,
    raw          jsonb,
    UNIQUE (user_id, source, external_id)
  );
  CREATE INDEX IF NOT EXISTS workouts_date ON workouts (user_id, date);

  -- Set-level strength logs (Strong, Hevy, etc). One row per SET, which the
  -- session-level workouts table cannot represent: the weight and reps are the
  -- whole point, and session fields repeat across every row of a workout.
  CREATE TABLE IF NOT EXISTS strength_sets (
    id           bigserial PRIMARY KEY,
    user_id      int REFERENCES users(id) ON DELETE CASCADE,
    date         date NOT NULL,
    started_at   timestamptz,
    session_name text,
    exercise     text NOT NULL,
    set_order    int,
    weight_kg    double precision,
    reps         double precision,
    rpe          double precision,
    distance_km  double precision,
    duration_s   double precision,
    session_min  double precision,
    source       text DEFAULT 'csv',
    external_id  text,
    UNIQUE (user_id, source, external_id)
  );
  CREATE INDEX IF NOT EXISTS strength_sets_date ON strength_sets (user_id, date);
  CREATE INDEX IF NOT EXISTS strength_sets_ex ON strength_sets (user_id, exercise, date);

  CREATE TABLE IF NOT EXISTS goals (
    id          serial PRIMARY KEY,
    user_id     int REFERENCES users(id) ON DELETE CASCADE,
    title       text NOT NULL,
    kind        text DEFAULT 'mixed',
    description text,
    start_date  date NOT NULL,
    target_date date,
    status      text DEFAULT 'active',
    narrative   text,
    created_at  timestamptz DEFAULT now(),
    archived_at timestamptz
  );

  CREATE TABLE IF NOT EXISTS goal_targets (
    id           serial PRIMARY KEY,
    goal_id      int REFERENCES goals(id) ON DELETE CASCADE,
    metric_key   text NOT NULL,
    direction    text NOT NULL DEFAULT 'increase',
    baseline     double precision,
    target_value double precision,
    weight       double precision DEFAULT 1,
    notes        text
  );

  CREATE TABLE IF NOT EXISTS entries (
    id         bigserial PRIMARY KEY,
    user_id    int REFERENCES users(id) ON DELETE CASCADE,
    date       date NOT NULL,
    kind       text DEFAULT 'note',
    body       text,
    meta       jsonb,
    created_at timestamptz DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS entries_date ON entries (user_id, date);

  CREATE TABLE IF NOT EXISTS photos (
    id         bigserial PRIMARY KEY,
    user_id    int REFERENCES users(id) ON DELETE CASCADE,
    date       date NOT NULL,
    mime       text,
    bytes      bytea,
    kind       text DEFAULT 'progress',
    analysis   jsonb,
    created_at timestamptz DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS photos_date ON photos (user_id, date);

  CREATE TABLE IF NOT EXISTS insights (
    id           bigserial PRIMARY KEY,
    user_id      int REFERENCES users(id) ON DELETE CASCADE,
    goal_id      int REFERENCES goals(id) ON DELETE SET NULL,
    kind         text DEFAULT 'briefing',
    period_start date,
    period_end   date,
    payload      jsonb,
    model        text,
    created_at   timestamptz DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS import_profiles (
    id         serial PRIMARY KEY,
    user_id    int REFERENCES users(id) ON DELETE CASCADE,
    name       text NOT NULL,
    kind       text DEFAULT 'metrics',
    mapping    jsonb NOT NULL,
    created_at timestamptz DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id        bigserial PRIMARY KEY,
    user_id   int REFERENCES users(id) ON DELETE CASCADE,
    provider  text,
    data_type text,
    ok        boolean,
    rows      int DEFAULT 0,
    message   text,
    ran_at    timestamptz DEFAULT now()
  );

  -- Long analyses run as resumable jobs rather than one long request. A
  -- serverless function is capped at 60s on Vercel's free tier, and the coach
  -- briefing needs several minutes of model time, so each HTTP call advances
  -- the job by one step and the client polls until it finishes.
  CREATE TABLE IF NOT EXISTS jobs (
    id         bigserial PRIMARY KEY,
    user_id    int REFERENCES users(id) ON DELETE CASCADE,
    kind       text NOT NULL,
    status     text NOT NULL DEFAULT 'running',   -- running | done | error
    goal_id    int REFERENCES goals(id) ON DELETE SET NULL,
    phase      text DEFAULT 'investigate',        -- investigate | write | finished
    steps      int DEFAULT 0,
    state      jsonb,       -- conversation so far
    trace      jsonb,       -- which tools have been called
    result     jsonb,
    error      text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS jobs_user ON jobs (user_id, kind, created_at DESC);

  CREATE TABLE IF NOT EXISTS settings (
    user_id int PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    tz      text DEFAULT 'Europe/London',
    prefs   jsonb DEFAULT '{}'::jsonb
  );
  `);
}

let migrated = false;
/** Run migrations once per warm serverless instance. */
export async function ensureDb() {
  if (migrated) return;
  await migrate();
  migrated = true;
}
