/**
 * The suite that matters most.
 *
 * This app's entire claim is that it separates signal from noise. The honest way
 * to test that is to feed it data with NO signal in it and count how often it
 * claims to find some. A random walk is the right null: it has no trend and no
 * change points, but it wanders convincingly and is the shape weight, HRV and
 * resting heart rate actually have.
 *
 * A test that only checks "does it find the trend I planted" cannot catch a
 * detector that finds trends in everything. This one can.
 */
import { describe, it, expect } from "vitest";
import { analyseTrend, findChangePoints } from "../trend";
import type { Point } from "../../metric-meta";

/** Deterministic PRNG so a failure is always reproducible. */
function seeded(seed: number) {
  return () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
}
const gauss = (r: () => number) => (r() + r() + r() + r() - 2) * 1.2;

/** Random walk: no trend, no level shifts, heavy autocorrelation — like real biometrics. */
function randomWalk(days: number, rng: () => number, start = 50): Point[] {
  let v = start;
  const out: Point[] = [];
  const d0 = Date.UTC(2025, 0, 1);
  for (let i = 0; i < days; i++) {
    v += gauss(rng);
    out.push({ date: new Date(d0 + i * 86_400_000).toISOString().slice(0, 10), value: v });
  }
  return out;
}

/** White noise around a constant: no autocorrelation, no trend. */
function whiteNoise(days: number, rng: () => number, mean = 50): Point[] {
  const d0 = Date.UTC(2025, 0, 1);
  return Array.from({ length: days }, (_, i) => ({
    date: new Date(d0 + i * 86_400_000).toISOString().slice(0, 10),
    value: mean + gauss(rng) * 3,
  }));
}

const N = 200;
const walks = Array.from({ length: N }, (_, s) => randomWalk(180, seeded((s + 1) * 7919)));
const noise = Array.from({ length: N }, (_, s) => whiteNoise(180, seeded((s + 1) * 104729)));

describe("false-positive rate on data with no signal", () => {
  it("does not invent trends in random walks (target <= 10/200)", () => {
    const hits = walks.filter((w) => analyseTrend(w)?.significant).length;
    expect(hits, `${hits}/${N} random walks reported a significant trend`).toBeLessThanOrEqual(10);
  });

  // Threshold reasoning: a correctly calibrated test at alpha ~0.05 lands near
  // 10/200 by definition, so demanding far fewer would mean a test with no
  // power rather than a better one. Was 200/200 before the correction.
  it("does not invent change points in random walks (target <= 12/200 series)", () => {
    const withCp = walks.filter((w) => findChangePoints(w).length > 0).length;
    expect(withCp, `${withCp}/${N} random walks reported a level shift`).toBeLessThanOrEqual(12);
  });

  it("does not invent trends in white noise", () => {
    const hits = noise.filter((w) => analyseTrend(w)?.significant).length;
    expect(hits, `${hits}/${N} white-noise series reported a significant trend`).toBeLessThanOrEqual(15);
  });

  it("does not invent change points in white noise", () => {
    const withCp = noise.filter((w) => findChangePoints(w).length > 0).length;
    expect(withCp, `${withCp}/${N} white-noise series reported a level shift`).toBeLessThanOrEqual(10);
  });
});

describe("still detects signal that is genuinely there", () => {
  // Guard against "fixing" the false positives by simply detecting nothing.
  it("finds a clear real trend under realistic noise", () => {
    // Drift of 0.35/day over 180 days moves the series ~63 units against a
    // random-walk spread of ~16 — roughly 4 sigma, unambiguously real.
    const found = Array.from({ length: 40 }, (_, s) => {
      const t = analyseTrend(randomWalk(180, seeded((s + 1) * 31337), 50)
        .map((p, i) => ({ ...p, value: p.value + i * 0.35 })));
      return t?.significant && t.direction === "rising";
    }).filter(Boolean).length;
    expect(found, `only ${found}/40 clear rising trends detected`).toBeGreaterThanOrEqual(34);
  });

  it("does NOT claim a trend that is weak relative to the noise", () => {
    // 0.12/day is only ~1.35 sigma above the walk's own wander. Claiming this
    // reliably would mean the test is over-firing; missing it often is correct.
    const found = Array.from({ length: 40 }, (_, s) => {
      const t = analyseTrend(randomWalk(180, seeded((s + 1) * 31337), 50)
        .map((p, i) => ({ ...p, value: p.value + i * 0.12 })));
      return t?.significant;
    }).filter(Boolean).length;
    expect(found, `${found}/40 — over-claiming a marginal trend`).toBeLessThanOrEqual(30);
  });

  it("finds a large genuine level shift", () => {
    const found = Array.from({ length: 40 }, (_, s) => {
      const rng = seeded((s + 1) * 6151);
      const pts = whiteNoise(180, rng, 50).map((p, i) => ({ ...p, value: p.value + (i >= 90 ? 18 : 0) }));
      const cps = findChangePoints(pts);
      // Must find it, and near where it actually is.
      return cps.some((c) => Math.abs(pts.findIndex((p) => p.date === c.date) - 90) <= 10);
    }).filter(Boolean).length;
    expect(found, `only ${found}/40 real level shifts detected`).toBeGreaterThanOrEqual(34);
  });
});
