import * as fs from "fs";
import * as path from "path";
import {
  computePacesFromRecentPerformance,
  computePeriodizedWeekMetrics,
  computeSessionTss,
  deriveStartWeeklyKm,
  extractSessionMetricsFromWorkouts,
  generatePeriodizedMultiWeekFallback,
  getEasySinglePace,
  getLockedDayNamesFromRules,
  normalizeGeneratedWorkout,
  updateBanisterLoad,
} from "./index";

/**
 * Characterization tests for the training-science core (RILES-035).
 *
 * `golden-fixtures.json` holds inputs AND outputs captured from LlmService
 * BEFORE the extraction: they pin the current science, byte for byte, so the
 * follow-up science-fix phase can change behavior deliberately, case by case.
 * A changed value here is a deliberate scientific decision, not an accident.
 *
 * These tests run without NestJS, DB, network or LLM (issue #28 acceptance).
 */
const golden: any = JSON.parse(
  fs.readFileSync(path.join(__dirname, "golden-fixtures.json"), "utf8"),
);

function eachGoldenCase(name: string, fn: (input: any, output: any) => void) {
  golden.inputs[name].forEach((input: any, i: number) => {
    it(`golden ${name}[${i}]: ${input.label ?? input}`, () => {
      fn(input, golden.outputs[name][i]);
    });
  });
}

describe("computePacesFromRecentPerformance (paces.ts)", () => {
  eachGoldenCase("paces", (input, output) => {
    expect(computePacesFromRecentPerformance(input.context)).toEqual(output);
  });

  it("watch zones take priority over recent sessions", () => {
    const paces = computePacesFromRecentPerformance({
      importedThresholdPaceSecPerKm: 300,
      importedEasyPaceSecPerKm: 360,
      recentSessions: [
        { avgPaceSecPerKm: 300, avgHeartRate: 150, distanceKm: 10 },
      ],
    });
    expect(paces.calibrationSource).toBe("watch_zones");
    expect(paces.thresholdPaceZ4).toBe("5:00/km");
  });

  it("is pure: same context, deep-equal output", () => {
    const context = golden.inputs.paces[3].context;
    expect(computePacesFromRecentPerformance(context)).toEqual(
      computePacesFromRecentPerformance(context),
    );
  });
});

describe("extractSessionMetricsFromWorkouts (paces.ts)", () => {
  eachGoldenCase("sessionMetrics", (input, output) => {
    expect(extractSessionMetricsFromWorkouts(input.workouts)).toEqual(output);
  });

  it("drops rest days, commutes and non-running sessions", () => {
    const metrics = extractSessionMetricsFromWorkouts([
      { actualPace: "5:00", isRestDay: true, sportType: "running" },
      { actualPace: "5:00", isCommute: true, sportType: "running" },
      { actualPace: "5:00", sportType: "cycling" },
    ]);
    expect(metrics).toEqual([]);
  });
});

describe("getEasySinglePace (paces.ts)", () => {
  it("returns the first value of the Z2 range", () => {
    expect(
      getEasySinglePace({
        easyPaceZ2: "5:45/km – 6:05/km",
        marathonPaceZ3: "5:15/km",
        thresholdPaceZ4: "4:52/km",
        intervalPaceZ5: "4:28/km",
        targetRacePace: "5:00/km",
      }),
    ).toBe("5:45/km");
  });

  it("falls back to 5:45/km when the range is empty", () => {
    expect(
      getEasySinglePace({
        easyPaceZ2: "",
        marathonPaceZ3: "5:15/km",
        thresholdPaceZ4: "4:52/km",
        intervalPaceZ5: "4:28/km",
        targetRacePace: "5:00/km",
      }),
    ).toBe("5:45/km");
  });
});

describe("computeSessionTss (banister.ts)", () => {
  eachGoldenCase("tss", (input, output) => {
    expect(computeSessionTss(...(input.args as [any, any, any]))).toEqual(
      output,
    );
  });

  it("scales monotonically with duration", () => {
    const short = computeSessionTss(1800, 150, 190);
    const mid = computeSessionTss(3600, 150, 190);
    const long = computeSessionTss(7200, 150, 190);
    expect(short).toBeGreaterThan(0);
    expect(mid).toBeGreaterThan(short);
    expect(long).toBeGreaterThan(mid);
  });

  it("scales monotonically with heart rate", () => {
    expect(computeSessionTss(3600, 170, 190)).toBeGreaterThan(
      computeSessionTss(3600, 140, 190),
    );
  });

  it("is pure: same arguments, same output", () => {
    expect(computeSessionTss(3600, 150, 190)).toBe(
      computeSessionTss(3600, 150, 190),
    );
  });
});

describe("updateBanisterLoad (banister.ts)", () => {
  eachGoldenCase("banister", (input, output) => {
    expect(updateBanisterLoad(...(input.args as [any, any, any]))).toEqual(
      output,
    );
  });

  it("ATL and CTL converge to a constant daily TSS (impulse-response)", () => {
    let atl = 0;
    let ctl = 0;
    for (let day = 0; day < 200; day++) {
      const next = updateBanisterLoad({
        previousAtl: atl,
        previousCtl: ctl,
        todayTss: 60,
      });
      atl = next.atlFatigue;
      ctl = next.ctlFitness;
    }
    expect(Math.abs(atl - 60)).toBeLessThan(0.5);
    // CTL is a 42-day EWMA rounded to 1 decimal each step: the increment
    // (60 - x) / 42 rounds away to 0.0 before reaching 60, so the absorbing
    // state sits ~2.1 below the target. Characterizes the current behavior.
    expect(Math.abs(ctl - 60)).toBeLessThan(2.5);
  });

  it("readiness stays within [40, 98]", () => {
    const fresh = updateBanisterLoad({
      previousAtl: 5,
      previousCtl: 60,
      todayTss: 0,
    });
    const overreached = updateBanisterLoad({
      previousAtl: 90,
      previousCtl: 40,
      todayTss: 0,
    });
    expect(fresh.readinessScore).toBeGreaterThanOrEqual(40);
    expect(fresh.readinessScore).toBeLessThanOrEqual(98);
    expect(overreached.readinessScore).toBeGreaterThanOrEqual(40);
    expect(overreached.readinessScore).toBeLessThanOrEqual(98);
  });

  it("is pure: same state, deep-equal output", () => {
    const state = { previousAtl: 35.2, previousCtl: 52.4, todayTss: 120 };
    expect(updateBanisterLoad(state)).toEqual(updateBanisterLoad(state));
  });
});

describe("getLockedDayNamesFromRules (plan-generator.ts)", () => {
  eachGoldenCase("lockedDays", (input, output) => {
    expect(Array.from(getLockedDayNamesFromRules(input.rules)).sort()).toEqual(
      output,
    );
  });
});

describe("normalizeGeneratedWorkout (plan-generator.ts)", () => {
  eachGoldenCase("normalize", (input, output) => {
    expect(
      normalizeGeneratedWorkout(
        input.slot,
        input.raw,
        new Set(input.lockedDays),
        input.paces,
      ),
    ).toEqual(output);
  });

  it("forces a rest day on a locked day even when the LLM proposed a session", () => {
    const input = golden.inputs.normalize[0];
    const workout = normalizeGeneratedWorkout(
      input.slot,
      { title: "Séance Seuil 5×6", category: "SÉANCE QUALITATIVE" },
      new Set(["Lun"]),
      input.paces,
    );
    expect(workout.isRestDay).toBe(true);
    expect(workout.timeLabel).toBe("Jour de repos");
    expect(workout.tss).toBe(0);
  });
});

describe("generatePeriodizedMultiWeekFallback (plan-generator.ts)", () => {
  eachGoldenCase("fallback", (input, output) => {
    expect(
      generatePeriodizedMultiWeekFallback(
        input.input,
        new Set(input.lockedDays),
        input.paces,
        input.modelName,
      ),
    ).toEqual(output);
  });

  it("rests every locked day and every default rest day of the week", () => {
    const input = golden.inputs.fallback[0];
    const { workouts } = generatePeriodizedMultiWeekFallback(
      input.input,
      new Set(input.lockedDays),
      input.paces,
      input.modelName,
    );
    const locked = new Set(input.lockedDays);
    for (const w of workouts) {
      if (locked.has(w.dayName) || w.dayName === "Dim" || w.dayName === "Jeu") {
        expect(w.isRestDay).toBe(true);
      }
    }
    for (const w of workouts) {
      if (["Mar", "Mer", "Ven", "Sam"].includes(w.dayName)) {
        expect(w.isRestDay).toBe(false);
      }
    }
  });

  it("starts week 1 at deriveStartWeeklyKm(base) x 22% on Monday", () => {
    const input = golden.inputs.fallback[2]; // recent4WeeksAvgKm = 45, Mer locked
    const { workouts } = generatePeriodizedMultiWeekFallback(
      input.input,
      new Set(input.lockedDays),
      input.paces,
      input.modelName,
    );
    const baseKm = input.input.sixMonthsStravaSummary.recent4WeeksAvgKm;
    const startKm = deriveStartWeeklyKm(baseKm);
    const mondayKm = Math.max(4.0, Number((startKm * 0.22).toFixed(1)));
    expect(workouts[0].dayName).toBe("Lun");
    expect(workouts[0].distance).toBe(
      `${mondayKm.toFixed(1).replace(".", ",")} km`,
    );
  });

  it("suffixes the caller-provided model name (deterministic engine branding)", () => {
    const input = golden.inputs.fallback[1];
    const result = generatePeriodizedMultiWeekFallback(
      input.input,
      new Set(input.lockedDays),
      input.paces,
      "custom-model",
    );
    expect(result.modelUsed).toBe("custom-model-periodized-engine");
  });

  it("is pure: same input, deep-equal output", () => {
    const input = golden.inputs.fallback[1];
    const run = () =>
      generatePeriodizedMultiWeekFallback(
        input.input,
        new Set(input.lockedDays),
        input.paces,
        input.modelName,
      );
    expect(run()).toEqual(run());
  });
});

describe("computePeriodizedWeekMetrics / deriveStartWeeklyKm (ramp rules)", () => {
  golden.inputs.weekMetrics.forEach((input: any, i: number) => {
    it(`golden weekMetrics[${i}]: week ${input.weekIndex}/${input.totalWeeks} @ ${input.startWeeklyKm} km`, () => {
      expect(
        computePeriodizedWeekMetrics(
          input.weekIndex,
          input.totalWeeks,
          input.startWeeklyKm,
        ),
      ).toEqual(golden.outputs.weekMetrics[i]);
    });
  });

  golden.inputs.startWeeklyKm.forEach((base: number, i: number) => {
    it(`golden startWeeklyKm[${i}]: base ${base} km/sem`, () => {
      expect(deriveStartWeeklyKm(base)).toEqual(
        golden.outputs.startWeeklyKm[i],
      );
    });
  });

  it("applies the 3:1 cycle: build, build, build, deload", () => {
    expect(computePeriodizedWeekMetrics(0, 8, 24).isDeload).toBe(false);
    expect(computePeriodizedWeekMetrics(2, 8, 24).isDeload).toBe(false);
    expect(computePeriodizedWeekMetrics(3, 8, 24).isDeload).toBe(true);
  });

  it("tapers the last two weeks of an 8+ week plan only", () => {
    expect(computePeriodizedWeekMetrics(6, 8, 24).isTaper).toBe(true);
    expect(computePeriodizedWeekMetrics(7, 8, 24).isTaper).toBe(true);
    expect(computePeriodizedWeekMetrics(2, 4, 24).isTaper).toBe(false);
  });

  it("caps the start volume between 18 and 30 km/sem", () => {
    expect(deriveStartWeeklyKm(0)).toBe(18);
    expect(deriveStartWeeklyKm(25)).toBe(21);
    expect(deriveStartWeeklyKm(60)).toBe(30);
  });
});

describe("module boundaries (issue #28 acceptance criteria)", () => {
  const moduleFiles = [
    "types.ts",
    "paces.ts",
    "banister.ts",
    "plan-generator.ts",
    "index.ts",
  ];

  /** Strip comments so doc prose cannot satisfy (or evade) a code pattern. */
  function codeOnly(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  it("imports nothing from NestJS, Prisma or the LLM provider layer", () => {
    for (const file of moduleFiles) {
      const code = codeOnly(
        fs.readFileSync(path.join(__dirname, file), "utf8"),
      );
      expect(code).not.toMatch(/from ["']@nestjs\//);
      expect(code).not.toMatch(/from ["']@prisma\//);
      expect(code).not.toMatch(/from ["']\.\.\/\.\.\/modules\//);
      expect(code).not.toMatch(/from ["']\.\.\/modules\//);
      expect(code).not.toMatch(/require\(/);
    }
  });

  it("uses no clock, no randomness and no I/O", () => {
    for (const file of moduleFiles) {
      const code = codeOnly(
        fs.readFileSync(path.join(__dirname, file), "utf8"),
      );
      expect(code).not.toMatch(/new Date\(/);
      expect(code).not.toMatch(/Date\.now/);
      expect(code).not.toMatch(/Math\.random/);
      expect(code).not.toMatch(/\bfetch\(/);
    }
  });
});
