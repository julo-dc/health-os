/**
 * The training-load model drives the app's injury-risk and "you're buried"
 * warnings, so a bias in it becomes a false health claim.
 *
 * Both EWMAs used to seed at zero, and the 7-day one converges about six times
 * faster than the 42-day one, so their ratio started absurdly high and decayed
 * for weeks. Every user was told they were at injury risk for their first ~45
 * days no matter what they did.
 */
import { describe, it, expect } from "vitest";
import { trainingLoad } from "../load";

const days = (n: number, load: (i: number) => number) => {
  const d0 = Date.UTC(2026, 0, 1);
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(d0 + i * 86_400_000).toISOString().slice(0, 10),
    load: load(i),
  }));
};

describe("steady training must never look like a spike", () => {
  const ls = trainingLoad(days(60, () => 100));

  it("recovers the true load from day one", () => {
    // REGRESSION: was ctl[0]=2.4, atl[0]=13.3
    expect(ls.ctl[0]).toBeCloseTo(100, 6);
    expect(ls.atl[0]).toBeCloseTo(100, 6);
    expect(ls.ctl[41]).toBeCloseTo(100, 6);
  });

  it("never reports an injury-risk acute:chronic ratio", () => {
    // REGRESSION: was 5.66 on day 0, still 1.58 on day 41
    const worst = Math.max(...ls.acwr.filter((v): v is number => v !== null));
    expect(worst, `peak ACWR ${worst.toFixed(2)} on identical daily training`).toBeLessThan(1.5);
  });

  it("never reports the athlete as buried", () => {
    // REGRESSION: was TSB -58.1 on day 14
    const worst = Math.min(...ls.tsb.filter((v): v is number => v !== null));
    expect(worst, `worst TSB ${worst.toFixed(1)} on identical daily training`).toBeGreaterThan(-25);
  });

  it("marks the model as established only once a chronic base exists", () => {
    expect(ls.established[0]).toBe(false);
    expect(ls.established[41]).toBe(false);
    expect(ls.established[42]).toBe(true);
  });
});

describe("still catches a real spike", () => {
  it("flags a genuine ramp after a layoff", () => {
    // Six weeks of nothing, then hard training: this IS the risky pattern.
    const ls = trainingLoad(days(60, (i) => (i < 42 ? 0 : 150)));
    const peak = Math.max(...ls.acwr.slice(42).filter((v): v is number => v !== null));
    expect(peak, "a real ramp should still exceed 1.5").toBeGreaterThan(1.5);
  });

  it("shows fitness decaying when training stops", () => {
    const ls = trainingLoad(days(120, (i) => (i < 60 ? 100 : 0)));
    expect(ls.ctl[59]).toBeCloseTo(100, 4);
    expect(ls.ctl[119]).toBeLessThan(30);      // ~42-day time constant
    expect(ls.tsb[119]!).toBeGreaterThan(0);   // fresh, and detrained
  });

  it("distinguishes a hard week from a steady one", () => {
    const steady = trainingLoad(days(60, () => 100));
    const spike = trainingLoad(days(60, (i) => (i >= 55 ? 400 : 100)));
    expect(spike.acwr[59]!).toBeGreaterThan(steady.acwr[59]! * 1.5);
  });
});
