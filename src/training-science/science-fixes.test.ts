import {
  buildDailyTssSeries,
  clampWeeklyVolumeRamp,
  computeReadinessScore,
  computeSessionTss,
  replayBanisterDaily,
  updateBanisterLoad,
} from "./index";

/**
 * Tests des correctifs de science d'entraînement (P3) :
 * - RILES-020 : EWMA qui avance par jour civil, pas par activité ;
 * - RILES-021 : IF/TSS sur la FC max de l'athlète ;
 * - RILES-023 : garde-fou +10 % par semaine ;
 * - RILES-026 : readiness qui pondère sommeil & HRV ;
 * - RILES-027 : sRPE comme charge de repli.
 */

describe("RILES-020: daily Banister replay", () => {
  it("3 consecutive rest days decay ATL toward 0 while CTL decays slowly", () => {
    // Charge initiale : une semaine à 60 TSS/j
    const trained = replayBanisterDaily(new Array(7).fill(60));
    // Puis 3 jours de repos enchaînés manuellement depuis cet état
    let atl = trained.atlFatigue;
    let ctl = trained.ctlFitness;
    const restDays = [0, 0, 0].map((tss) => {
      const next = updateBanisterLoad({
        previousAtl: atl,
        previousCtl: ctl,
        todayTss: tss,
      });
      atl = next.atlFatigue;
      ctl = next.ctlFitness;
      return next;
    });

    expect(restDays[0].atlFatigue).toBeLessThan(trained.atlFatigue);
    expect(restDays[1].atlFatigue).toBeLessThan(restDays[0].atlFatigue);
    expect(restDays[2].atlFatigue).toBeLessThan(restDays[1].atlFatigue);
    // ATL (τ=7j) décroît vite, CTL (τ=42j) beaucoup plus lentement
    const atlDrop = trained.atlFatigue - restDays[2].atlFatigue;
    const ctlDrop = trained.ctlFitness - restDays[2].ctlFitness;
    expect(atlDrop).toBeGreaterThan(ctlDrop);
  });

  it("replay over 180 days performs exactly 180 steps", () => {
    const days = Array.from({ length: 180 }, (_, i) => (i % 7 === 0 ? 120 : 0));
    const result = replayBanisterDaily(days);
    expect(result.steps).toBe(180);
  });

  it("buildDailyTssSeries inserts zero-TSS calendar days between activities", () => {
    const series = buildDailyTssSeries([
      { dateKey: "2026-10-01", tss: 80 },
      { dateKey: "2026-10-04", tss: 100 }, // 2 jours de repos entre les deux
      { dateKey: "2026-10-04", tss: 20 }, // même jour : les charges s'additionnent
    ]);
    expect(series).toEqual([80, 0, 0, 120]);
  });

  it("is deterministic and ignores malformed date keys", () => {
    expect(
      buildDailyTssSeries([
        { dateKey: "not-a-date", tss: 50 },
        { dateKey: "2026-02-01", tss: 30 },
        { dateKey: "2026-02-02", tss: 0 },
      ]),
    ).toEqual([30, 0]);
  });
});

describe("RILES-021: TSS uses the athlete's HRmax, not the session peak", () => {
  const effort = (maxHeartRate: number) =>
    computeSessionTss({
      durationSec: 3600,
      avgHeartRate: 160,
      maxHeartRate,
      hrMax: 190,
    });

  it("two identical efforts at different session peaks yield comparable TSS", () => {
    expect(effort(170)).toBe(effort(195));
  });

  it("the session peak alone no longer inflates TSS when athlete HRmax is known", () => {
    const withAthleteHrMax = computeSessionTss({
      durationSec: 3600,
      avgHeartRate: 160,
      maxHeartRate: 185,
      hrMax: 180,
    });
    const withoutAthleteHrMax = computeSessionTss({
      durationSec: 3600,
      avgHeartRate: 160,
      maxHeartRate: 185,
    });
    // hrMax 180 → IF plus élevée → TSS plus élevé qu'avec l'estimation 190
    expect(withAthleteHrMax).toBeGreaterThan(withoutAthleteHrMax);
  });

  it("documented fallback HRmax (190) applies when the athlete is unknown", () => {
    expect(computeSessionTss(3600, 160, 190)).toBe(
      computeSessionTss({ durationSec: 3600, avgHeartRate: 160 }),
    );
  });
});

describe("RILES-027: sRPE load path", () => {
  it("computes TSS from RPE × duration when HR is absent", () => {
    // 60 min à RPE 8 → sRPE 480 → 80 TSS (échelle : 60 min à RPE 10 = 100)
    expect(
      computeSessionTss({ durationSec: 3600, rpe: 8 }),
    ).toBe(80);
    expect(
      computeSessionTss({ durationSec: 3600, srpe: 480 }),
    ).toBe(80);
  });

  it("HR path takes precedence over sRPE when both are present", () => {
    const hrBased = computeSessionTss({
      durationSec: 3600,
      avgHeartRate: 160,
      hrMax: 190,
      rpe: 10,
    });
    const srpeOnly = computeSessionTss({ durationSec: 3600, rpe: 10 });
    expect(hrBased).not.toBe(srpeOnly);
  });

  it("falls back to the neutral 0.75 ratio when neither HR nor RPE exists", () => {
    expect(computeSessionTss({ durationSec: 3600 })).toBe(
      computeSessionTss(3600, undefined),
    );
  });
});

describe("RILES-026: readiness weighs sleep and HRV", () => {
  it("sleep above/below average shifts the score", () => {
    const rested = computeReadinessScore(10, 90);
    const tired = computeReadinessScore(10, 50);
    const neutral = computeReadinessScore(10, 70);
    expect(rested).toBeGreaterThan(neutral);
    expect(tired).toBeLessThan(neutral);
    expect(rested - neutral).toBe(5);
    expect(neutral - tired).toBe(5);
  });

  it("HRV status adjusts the score in the documented direction", () => {
    expect(computeReadinessScore(10, undefined, "balanced")).toBeGreaterThan(
      computeReadinessScore(10),
    );
    expect(
      computeReadinessScore(10, undefined, "unbalanced"),
    ).toBeLessThan(computeReadinessScore(10));
    // statut inconnu → pas d'effet
    expect(computeReadinessScore(10, undefined, "unknown-status")).toBe(
      computeReadinessScore(10),
    );
  });

  it("updateBanisterLoad forwards sleep/HRV to the readiness score", () => {
    const base = updateBanisterLoad({
      previousAtl: 35.2,
      previousCtl: 52.4,
      todayTss: 120,
    });
    const withRecovery = updateBanisterLoad({
      previousAtl: 35.2,
      previousCtl: 52.4,
      todayTss: 120,
      sleepScore: 90,
      hrvStatus: "balanced",
    });
    expect(withRecovery.readinessScore).toBeGreaterThan(base.readinessScore);
    expect(withRecovery.atlFatigue).toBe(base.atlFatigue);
  });

  it("stays within [40, 98]", () => {
    expect(computeReadinessScore(60, 100, "balanced")).toBeLessThanOrEqual(98);
    expect(computeReadinessScore(-60, 20, "unbalanced")).toBeGreaterThanOrEqual(
      40,
    );
  });
});

describe("RILES-023: weekly volume ramp clamp", () => {
  it("clamps a week above +10 % of the reference", () => {
    expect(clampWeeklyVolumeRamp(45, 40)).toEqual({ km: 44, clamped: true });
    expect(clampWeeklyVolumeRamp(44, 40)).toEqual({ km: 44, clamped: false });
    expect(clampWeeklyVolumeRamp(43, 40)).toEqual({ km: 43, clamped: false });
  });

  it("never clamps decreases (the athlete asked for less volume)", () => {
    expect(clampWeeklyVolumeRamp(20, 40)).toEqual({ km: 20, clamped: false });
  });

  it("5 maximal 'harder' adaptations never exceed +10 % vs the trailing 4-week average", () => {
    // Historique : 4 semaines à 40 km/sem
    const history = [40, 40, 40, 40];
    let week = 40;
    for (let adaptation = 0; adaptation < 5; adaptation++) {
      const reference =
        history.slice(-4).reduce((a, b) => a + b, 0) /
        Math.min(4, history.length);
      const proposed = week * 1.15; // demande "plus dur" flat +15 %
      week = clampWeeklyVolumeRamp(proposed, reference).km;
      // Critère d'acceptation : chaque semaine reste ≤ +10 % de la moyenne
      // des 4 dernières semaines, même à répétition.
      expect(week).toBeLessThanOrEqual(reference * 1.1 + 0.05);
      history.push(week);
    }
    // et la suite est toujours croissante (pas de blocage à zéro)
    expect(history[history.length - 1]).toBeGreaterThan(40);
  });
});
