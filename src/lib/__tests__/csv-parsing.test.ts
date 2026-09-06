/**
 * Parser contract.
 *
 * These functions decide what number reaches the database, so a wrong answer
 * here is silent, permanent data corruption — and every case below was a real
 * wrong answer, not a hypothetical.
 *
 * The governing rule: NEVER GUESS A UNIT. parseNumber returns a dimensionless
 * number or null; parseDuration returns minutes, always. Anything ambiguous is
 * rejected rather than salvaged, because the import flow already asks the user
 * to confirm a unit and a wrong silent answer is worse than a question.
 */
import { describe, it, expect } from "vitest";
import { parseNumber, parseDuration, parseDate } from "../csv";

describe("parseNumber — plain numbers only", () => {
  it("handles both decimal conventions", () => {
    expect(parseNumber("1,234.56")).toBe(1234.56);       // US
    expect(parseNumber("1.234,56")).toBe(1234.56);       // REGRESSION: gave 1.23456, a 1000x error
    expect(parseNumber("1234.56")).toBe(1234.56);
    expect(parseNumber("0,5")).toBe(0.5);
    expect(parseNumber("12")).toBe(12);
    expect(parseNumber("-3.5")).toBe(-3.5);
  });

  it("reads a number that carries a unit", () => {
    // REGRESSION: all returned null, because 'e' was preserved for scientific
    // notation and then corrupted the value to NaN.
    expect(parseNumber("1000 steps")).toBe(1000);
    expect(parseNumber("12 reps")).toBe(12);
    expect(parseNumber("5 miles")).toBe(5);
    expect(parseNumber("70 kg")).toBe(70);
    expect(parseNumber("50%")).toBe(50);
    expect(parseNumber("$1,250.00")).toBe(1250);
  });

  it("keeps negative signs however they are written", () => {
    expect(parseNumber("−5")).toBe(-5);   // REGRESSION: U+2212 minus gave +5
    expect(parseNumber("–5")).toBe(-5);   // en dash
    expect(parseNumber("(1.5)")).toBe(-1.5);   // REGRESSION: accounting negative gave +1.5
  });

  it("refuses things that are not plain numbers", () => {
    expect(parseNumber("12/05/2024")).toBeNull();  // REGRESSION: gave 12052024
    expect(parseNumber("2024-05-12")).toBeNull();
    expect(parseNumber("1:30")).toBeNull();        // a duration is not a bare number
    expect(parseNumber("7.5h")).toBeNull();        // REGRESSION: gave 450
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("N/A")).toBeNull();
    expect(parseNumber("—")).toBeNull();
    expect(parseNumber("abc")).toBeNull();
  });

  it("accepts genuine scientific notation only when the whole string is one", () => {
    expect(parseNumber("1.5e3")).toBe(1500);
    expect(parseNumber("1.5e")).toBeNull();
  });
});

describe("parseDuration — always minutes", () => {
  it("agrees with itself across every spelling of 90 minutes", () => {
    // REGRESSION: "1:30" gave 1.5 (hours) while "1h 30m" gave 90 (minutes) —
    // the same duration in two different units from one function.
    for (const s of ["1:30", "1:30:00", "1h 30m", "1.5h", "90m", "90 min"]) {
      expect(parseDuration(s), `${s} should be 90 minutes`).toBeCloseTo(90, 6);
    }
  });

  it("handles the rest of the common spellings", () => {
    expect(parseDuration("2h")).toBe(120);
    expect(parseDuration("45s")).toBeCloseTo(0.75, 6);
    expect(parseDuration("0:45:30")).toBeCloseTo(45.5, 6);
    expect(parseDuration("1h 15min 30s")).toBeCloseTo(75.5, 6);
    expect(parseDuration("PT1H30M")).toBeCloseTo(90, 6);   // Garmin / Apple
  });

  it("refuses a bare number, which carries no unit", () => {
    expect(parseDuration("90")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });
});

describe("parseDate — reject impossible dates rather than roll them over", () => {
  it("accepts real dates", () => {
    expect(parseDate("2024-05-12")).toBe("2024-05-12");
    expect(parseDate("12/05/2024")).toBe("2024-05-12");   // day-first
    expect(parseDate("29/02/2024")).toBe("2024-02-29");   // leap year
  });

  it("rejects dates that do not exist", () => {
    // REGRESSION: these were returned verbatim or rolled over silently, and
    // "2024-00-00" then crashed weekdayProfile with buckets[NaN].push
    expect(parseDate("2024-13-45")).toBeNull();
    expect(parseDate("31/02/2024")).toBeNull();
    expect(parseDate("0/0/2024")).toBeNull();
    expect(parseDate("2024-02-30")).toBeNull();
    expect(parseDate("29/02/2023")).toBeNull();           // not a leap year
    expect(parseDate("")).toBeNull();
    expect(parseDate("not a date")).toBeNull();
  });
});
