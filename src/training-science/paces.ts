/**
 * Training-science core — pure domain functions (RILES-035 / issue #28).
 *
 * Boundaries: this module imports NOTHING from NestJS, Prisma, or the LLM
 * provider layer. No I/O, no `Date.now()`, no randomness — same inputs always
 * produce the same outputs, which is what makes the science falsifiable.
 */
import {
  AthleteTrainingContext,
  RecentSessionMetric,
  SessionWorkoutSource,
  TargetPaces,
} from "./types";

/**
 * Calcule les allures d'entraînement UNIQUEMENT à partir des séances récentes
 * (allure observée + fréquence cardiaque associée) ou des zones de montre synchronisées
 * (Garmin Lactate Threshold / Strava Activities & HR Zones).
 * Ne calcule JAMAIS les allures d'entraînement à partir du chrono rêvé de l'objectif !
 */
export function computePacesFromRecentPerformance(
  trainingContext?: AthleteTrainingContext,
): TargetPaces {
  const fmt = (sec: number) => {
    const clamped = Math.max(165, Math.min(540, Math.round(sec)));
    const m = Math.floor(clamped / 60);
    const s = Math.round(clamped % 60);
    return `${m}:${String(s).padStart(2, "0")}/km`;
  };

  // Priorité 1 : Seuil lactique ou zones directement importées depuis Garmin / Strava
  if (trainingContext?.importedThresholdPaceSecPerKm) {
    const thresholdSec = trainingContext.importedThresholdPaceSecPerKm;
    const easyCenterSec =
      trainingContext.importedEasyPaceSecPerKm || thresholdSec + 58;
    return {
      easyPaceZ2: `${fmt(easyCenterSec - 10)} – ${fmt(easyCenterSec + 10)}`,
      marathonPaceZ3: fmt(thresholdSec + 20),
      thresholdPaceZ4: fmt(thresholdSec),
      intervalPaceZ5: fmt(thresholdSec - 22),
      targetRacePace: fmt(thresholdSec + 8),
      calibrationSource: "watch_zones",
    };
  }

  // Priorité 2 : Calcul à partir des séances récentes (Allure réelle + Fréquence Cardiaque)
  const rawSessions = (trainingContext?.recentSessions || []).filter(
    (s) => s.avgPaceSecPerKm && s.avgPaceSecPerKm > 150,
  );
  if (rawSessions.length > 0) {
    // Si l'athlète a des séances sur route (<= 7:40/km = 460s/km), on écarte des allures plat
    // les ultra-trails montagneux à fort D+ (ex: 13:30/km) qui fausseraient les zones Z2-Z5 route.
    const roadSessions = rawSessions.filter(
      (s) => (s.avgPaceSecPerKm || 0) <= 460,
    );
    const sessions = roadSessions.length > 0 ? roadSessions : rawSessions;

    const hrMax =
      trainingContext?.hrMax ||
      Math.max(188, ...rawSessions.map((s) => s.maxHeartRate || 0));

    let weightedThresholdSum = 0;
    let totalWeight = 0;

    for (const session of sessions) {
      if (!session.avgPaceSecPerKm || session.avgPaceSecPerKm <= 0) continue;
      // Plafonne le poids d'une séance unique à 18 km pour éviter qu'un seul ultra écrase tout l'historique
      const weight = Math.min(18, Math.max(1, session.distanceKm || 5));

      if (session.avgHeartRate && session.avgHeartRate > 95) {
        // Ratio d'intensité cardiaque de la séance (ex: 145 bpm / 190 bpm = 0.763 -> 76.3% FCmax)
        const hrRatio = Math.min(
          0.98,
          Math.max(0.6, session.avgHeartRate / hrMax),
        );
        // Le seuil anaérobie (Z4) se situe autour de 88% FCmax.
        // Dérive physiologique moyenne : ~3.8 sec/km par point de % de FCmax.
        const deltaPctToThreshold = (0.88 - hrRatio) * 100;
        const estimatedThresholdFromSession =
          session.avgPaceSecPerKm - deltaPctToThreshold * 3.8;

        weightedThresholdSum += estimatedThresholdFromSession * weight;
        totalWeight += weight;
      } else {
        // Si pas de FC sur cette sortie, on considère une sortie courante (~78% FCmax -> seuil ~35s plus rapide)
        weightedThresholdSum += (session.avgPaceSecPerKm - 35) * weight;
        totalWeight += weight;
      }
    }

    if (totalWeight > 0) {
      const thresholdSec = Math.round(weightedThresholdSum / totalWeight);
      const easyMinSec = thresholdSec + 48;
      const easyMaxSec = thresholdSec + 68;
      const marathonSec = thresholdSec + 20;
      const intervalSec = thresholdSec - 22;

      return {
        easyPaceZ2: `${fmt(easyMinSec)} – ${fmt(easyMaxSec)}`,
        marathonPaceZ3: fmt(marathonSec),
        thresholdPaceZ4: fmt(thresholdSec),
        intervalPaceZ5: fmt(intervalSec),
        targetRacePace: fmt(thresholdSec + 8),
        calibrationSource: "recent_sessions_hr",
      };
    }
  }

  // Priorité 3 : Base par défaut en attente des premières séances synchronisées
  return {
    easyPaceZ2: "5:45/km – 6:05/km",
    marathonPaceZ3: "5:15/km",
    thresholdPaceZ4: "4:52/km",
    intervalPaceZ5: "4:28/km",
    targetRacePace: "5:00/km",
    calibrationSource: "default_baseline",
  };
}

/**
 * Convertit les séances (Workouts Prisma) en métriques (allure sec/km + FC bpm)
 * Utilise EN PRIORITÉ les vraies données de la séance réalisée (actualPace, actualAvgHeartRate, actualMaxHeartRate, actualDistanceKm)
 * issues des webhooks Strava / Garmin / Apple Santé.
 */
export function extractSessionMetricsFromWorkouts(
  workouts: SessionWorkoutSource[],
): RecentSessionMetric[] {
  const metrics: NonNullable<RecentSessionMetric[]> = [];

  for (const w of workouts) {
    if (w.isRestDay || w.isCommute) continue;
    if (w.sportType && w.sportType !== "running") continue;

    const paceStr = w.actualPace || w.targetPace;
    if (!paceStr || paceStr.toLowerCase().includes("km/h")) continue;

    const paceMatch = paceStr.match(/(\d+):(\d{2})/);
    if (!paceMatch) continue;
    const avgPaceSecPerKm =
      parseInt(paceMatch[1], 10) * 60 + parseInt(paceMatch[2], 10);

    // Priorité à la vraie fréquence cardiaque moyenne mesurée par la montre
    let avgHeartRate: number | undefined = w.actualAvgHeartRate ?? undefined;
    if (!avgHeartRate && w.targetZoneBpm) {
      const bpmMatches = w.targetZoneBpm.match(/(\d{2,3})/g);
      if (bpmMatches && bpmMatches.length >= 2) {
        avgHeartRate = Math.round(
          (parseInt(bpmMatches[0], 10) + parseInt(bpmMatches[1], 10)) / 2,
        );
      } else if (bpmMatches && bpmMatches.length === 1) {
        avgHeartRate = parseInt(bpmMatches[0], 10);
      }
    }

    // Priorité à la vraie distance mesurée par la montre
    let distanceKm = w.actualDistanceKm ?? undefined;
    if (!distanceKm && w.distance) {
      const distMatch = w.distance.match(/(\d+(?:[.,]\d+)?)/);
      distanceKm = distMatch ? parseFloat(distMatch[1].replace(",", ".")) : 8;
    }

    metrics.push({
      avgPaceSecPerKm,
      avgHeartRate,
      maxHeartRate: w.actualMaxHeartRate ?? undefined,
      distanceKm: distanceKm || 8,
    });
  }

  return metrics;
}

/**
 * Allure Z2 "single value" used everywhere a single pace is needed
 * (first value of the Z2 range, fallback 5:45/km).
 */
export function getEasySinglePace(paces: TargetPaces): string {
  return paces.easyPaceZ2.split("–")[0]?.trim() || "5:45/km";
}
