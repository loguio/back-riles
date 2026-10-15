import { WebhooksService } from "./webhooks.service";
import {
  buildDailyTssSeries,
  computeReadinessScore,
  replayBanisterDaily,
} from "../../training-science";

/**
 * Tests des correctifs P3 côté webhooks :
 * - RILES-022 : fenêtre « 4 dernières semaines » glissante (plus de semaines
 *   ISO codées en dur) — vérifiée à deux dates de clocher différentes ;
 * - RILES-020 : le replay Banister avance par jour civil.
 */

function makeService() {
  const llmService = {
    computeSessionTss: jest.fn(() => 55),
    updateBanisterLoad: jest.fn(),
    buildDailyTssSeries: jest.fn((e: Array<{ dateKey: string; tss: number }>) =>
      buildDailyTssSeries(e),
    ),
    replayBanisterDaily: jest.fn((d: number[]) => replayBanisterDaily(d)),
    computeReadinessScore: jest.fn((t: number, s?: number, h?: string) =>
      computeReadinessScore(t, s, h),
    ),
    computePacesFromRecentPerformance: jest.fn(() => ({
      easyPaceZ2: "5:30/km",
      thresholdPaceZ4: "4:45/km",
    })),
    extractSessionMetricsFromWorkouts: jest.fn(() => []),
  };
  const prisma: any = { user: { findUnique: jest.fn() } };
  const dataLake = { logTrainingInteraction: jest.fn() };
  const config: any = { get: () => undefined };
  const service = new WebhooksService(
    prisma,
    config,
    dataLake as any,
    llmService as any,
  );
  return { service, llmService };
}

/** Construit une activité de course minimale pour la date donnée. */
function run(dateKey: string, km: number) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const isoWeek = Math.ceil(
    ((dt.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7,
  );
  return {
    dateKey,
    year: y,
    month: m - 1,
    weekNumber: isoWeek,
    isRestDay: false,
    isCommute: false,
    sportType: "running",
    category: "ENDURANCE FONDAMENTALE",
    actualDistanceKm: km,
    actualDurationSec: Math.round(km * 330),
    actualAvgHeartRate: 150,
    actualMaxHeartRate: 175,
    tss: 60,
  };
}

describe("RILES-022 — fenêtre « 4 dernières semaines » glissante", () => {
  it("no literal ISO week numbers: the window follows the anchor date", () => {
    const { service } = makeService();
    // Volume croissant sur 6 semaines : les fenêtres glissantes ne capent pas
    // les mêmes activités selon la date de référence.
    const workouts = [
      run("2026-08-24", 8),
      run("2026-08-31", 9),
      run("2026-09-07", 10),
      run("2026-09-14", 11),
      run("2026-09-21", 20),
      run("2026-09-28", 22),
      run("2026-10-04", 24),
    ];

    // Clocher A : ancre au 2026-10-04 → fenêtre = 2026-09-08..2026-10-04
    // (sorties récentes de 11/20/22/24 km).
    const a = service.computeSixMonthsSummaryFromWorkouts(
      workouts,
      "strava_history_import",
      "2026-10-04",
    );
    // Clocher B : ancre au 2026-09-20 → fenêtre = 2026-08-24..2026-09-20
    // (sorties anciennes de 8/9/10/11 km).
    const b = service.computeSixMonthsSummaryFromWorkouts(
      workouts,
      "strava_history_import",
      "2026-09-20",
    );

    // Une fenêtre codée en dur (ex. semaines ISO 38–41) renverrait la même
    // moyenne quelle que soit la date : ici elle glisse avec l'ancre.
    expect(a.recent4WeeksAvgKm).toBeGreaterThan(b.recent4WeeksAvgKm);
    expect(b.recent4WeeksAvgKm).toBeGreaterThan(0);
  });

  it("is anchored on the last activity when no explicit date is given", () => {
    const { service } = makeService();
    const workouts = [
      run("2026-09-01", 20),
      run("2026-10-01", 30),
      run("2026-10-03", 40),
    ];
    const implicit = service.computeSixMonthsSummaryFromWorkouts(
      workouts,
      "strava_history_import",
    );
    const explicit = service.computeSixMonthsSummaryFromWorkouts(
      workouts,
      "strava_history_import",
      "2026-10-03",
    );
    expect(implicit.recent4WeeksAvgKm).toBe(explicit.recent4WeeksAvgKm);
  });
});

describe("RILES-020 — rejeu Banister par jour civil (webhooks)", () => {
  it("steps the EWMA once per calendar day, decay included on rest days", () => {
    const { service, llmService } = makeService();
    // 3 jours d'activité espacés de 3 jours de repos.
    const workouts = [
      run("2026-09-01", 10),
      run("2026-09-05", 10),
      run("2026-09-09", 10),
    ];
    service.computeSixMonthsSummaryFromWorkouts(
      workouts,
      "strava_history_import",
      "2026-09-09",
    );
    // buildDailyTssSeries étale sur tous les jours civils (01→09 = 9 jours).
    const seriesCall = llmService.buildDailyTssSeries.mock.calls[0][0];
    const series = buildDailyTssSeries(seriesCall);
    expect(series.length).toBe(9); // 8 jours d'écart + 1
    // Les jours de repos ont une charge de 0 (décroissance appliquée).
    expect(series.filter((t) => t === 0).length).toBe(6);
  });
});
