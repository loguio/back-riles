/**
 * Training-science core — pure domain functions (RILES-035 / issue #28).
 *
 * Boundaries: this module imports NOTHING from NestJS, Prisma, or the LLM
 * provider layer. No I/O, no `Date.now()`, no randomness — same inputs always
 * produce the same outputs, which is what makes the science falsifiable.
 */
import {
  BanisterLoadInput,
  BanisterLoadResult,
  SessionTssInput,
} from "./types";

/**
 * Calcule le Training Stress Score (hrTSS / Banister TRIMP normalisé) d'une séance
 */
export function computeSessionTss(
  durationSecOrObj: number | SessionTssInput,
  avgHeartRateArg?: number,
  hrMaxArg = 190,
): number {
  const durationSec =
    typeof durationSecOrObj === "number"
      ? durationSecOrObj
      : durationSecOrObj?.durationSec || 0;
  const avgHeartRate =
    typeof durationSecOrObj === "number"
      ? avgHeartRateArg
      : durationSecOrObj?.avgHeartRate;
  const hrMax =
    typeof durationSecOrObj === "number"
      ? hrMaxArg
      : Math.max(185, durationSecOrObj?.maxHeartRate || 190);

  if (!durationSec || durationSec <= 0) return 0;
  const hours = durationSec / 3600;
  const hrRatio = avgHeartRate
    ? Math.min(1, Math.max(0.55, avgHeartRate / hrMax))
    : 0.75;
  // Intensité relative par rapport au seuil (~0.88 FCmax = IF 1.0 -> 100 TSS/heure)
  const intensityFactor = hrRatio / 0.88;
  return Math.round(hours * intensityFactor * intensityFactor * 100);
}

/**
 * Met à jour les charges physiologiques de Banister :
 * - ATL (Fatigue aiguë 7 jours)
 * - CTL (Condition chronique 42 jours)
 * - TSB (Forme = CTL - ATL)
 * - ReadinessScore (0-100)
 */
export function updateBanisterLoad(
  currentAtlOrObj: number | BanisterLoadInput,
  currentCtlArg?: number,
  sessionTssArg?: number,
): BanisterLoadResult {
  const currentAtl =
    typeof currentAtlOrObj === "number"
      ? currentAtlOrObj
      : currentAtlOrObj.previousAtl;
  const currentCtl =
    typeof currentAtlOrObj === "number"
      ? (currentCtlArg ?? 48)
      : currentAtlOrObj.previousCtl;
  const sessionTss =
    typeof currentAtlOrObj === "number"
      ? (sessionTssArg ?? 0)
      : currentAtlOrObj.todayTss;

  const atlFatigue = Number(
    (currentAtl + (sessionTss - currentAtl) / 7).toFixed(1),
  );
  const ctlFitness = Number(
    (currentCtl + (sessionTss - currentCtl) / 42).toFixed(1),
  );
  const tsbForm = Number((ctlFitness - atlFatigue).toFixed(1));
  const readinessScore = Math.max(
    40,
    Math.min(98, Math.round(82 + tsbForm * 0.6)),
  );

  return { atlFatigue, ctlFitness, tsbForm, readinessScore };
}
