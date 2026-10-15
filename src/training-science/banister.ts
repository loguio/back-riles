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
  BanisterReplayResult,
  DailyTssEntry,
  SessionTssInput,
} from "./types";

/**
 * Estimation documentée de la FC max de l'athlète quand `User.hrMax` n'est pas
 * renseigné : 190 bpm correspond à 220 − âge pour un athlète d'une trentaine
 * d'années (méthode standard, voir RILES-021). Ce n'est plus jamais la FC max
 * *observée sur la séance* — celle-ci varie d'une séance à l'autre et rendait
 * le TSS non comparable (RILES-021).
 */
export const DEFAULT_ATHLETE_HRMAX = 190;

/** Seuil minimal en dessous duquel un ratio FC/FCmax est plafonné (zombie
 * capteur, données aberrantes). */
const MIN_HR_RATIO = 0.55;

/** IF de référence : à 88 % de la FCmax, un hour d'effort vaut 100 TSS. */
const IF_REFERENCE_RATIO = 0.88;

/**
 * Calcule le Training Stress Score (hrTSS) d'une séance.
 *
 * Précedence de la charge interne (RILES-027) :
 *  1. Basée sur la FC (hrTSS) si `avgHeartRate` est disponible ;
 *  2. Sinon sRPE (RPE × durée) si `rpe` ou `srpe` est disponible :
 *     TSS_srpe = (rating × durée_min) / 6, i.e. 60 min à RPE 10 = 100 TSS ;
 *  3. Sinon ratio par défaut 0.75 (aucune donnée, estimation neutre).
 *
 * L'IF est calculé sur la FCmax *de l'athlète* (`hrMax`, défaut documenté
 * `DEFAULT_ATHLETE_HRMAX`), jamais sur la FC max observée sur la séance :
 * deux efforts identiques à pics de FC différents produisent le même TSS
 * (RILES-021).
 */
export function computeSessionTss(
  durationSecOrObj: number | SessionTssInput,
  avgHeartRateArg?: number,
  hrMaxArg = DEFAULT_ATHLETE_HRMAX,
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
      : durationSecOrObj?.hrMax || DEFAULT_ATHLETE_HRMAX;

  if (!durationSec || durationSec <= 0) return 0;
  const hours = durationSec / 3600;

  if (avgHeartRate) {
    const hrRatio = Math.min(
      1,
      Math.max(MIN_HR_RATIO, avgHeartRate / Math.max(1, hrMax)),
    );
    // Intensité relative par rapport au seuil (~0.88 FCmax = IF 1.0 -> 100 TSS/heure)
    const intensityFactor = hrRatio / IF_REFERENCE_RATIO;
    return Math.round(hours * intensityFactor * intensityFactor * 100);
  }

  // Pas de FC : sRPE (RILES-027) si le RPE de la séance est connu.
  const srpe =
    typeof durationSecOrObj === "number"
      ? undefined
      : durationSecOrObj?.srpe ??
        (durationSecOrObj?.rpe
          ? durationSecOrObj.rpe * (durationSec / 60)
          : undefined);
  if (srpe && srpe > 0) {
    return Math.round(srpe / 6);
  }

  // Aucune donnée de charge : ratio par défaut documenté (estimation neutre).
  const intensityFactor = 0.75 / IF_REFERENCE_RATIO;
  return Math.round(hours * intensityFactor * intensityFactor * 100);
}

/**
 * Score de fraîcheur / readiness (0-100) documenté (RILES-026).
 *
 * Base  : 82 + TSB × 0.6 (TSB = CTL − ATL, la fameuse « forme »).
 * Sommeil : (sleepScore − 70) × 0.25 — un sommeil au-dessus/moins de la
 *           moyenne (70) décale le score de ±5 points pour 90/50.
 * HRV    : "optim(al)/balanced/équilibré" → +3 ; "unbalanced/low/mauvais" →
 *          −5 ; toute autre valeur (ou absente) → 0.
 * Toutes les valeurs sont bornées à [40, 98].
 */
export function computeReadinessScore(
  tsbForm: number,
  sleepScore?: number,
  hrvStatus?: string,
): number {
  let score = 82 + tsbForm * 0.6;

  if (sleepScore && sleepScore > 0) {
    score += (sleepScore - 70) * 0.25;
  }

  if (hrvStatus) {
    const s = hrvStatus.toLowerCase();
    if (
      s.includes("unbalanc") ||
      s.includes("low") ||
      s.includes("poor") ||
      s.includes("déséquilibr") ||
      s.includes("desequilibr")
    ) {
      score -= 5;
    } else if (
      s.includes("optim") ||
      s.includes("balanced") ||
      s.includes("équilibr") ||
      s.includes("equilibr")
    ) {
      score += 3;
    }
  }

  return Math.max(40, Math.min(98, Math.round(score)));
}

/**
 * Met à jour les charges physiologiques de Banister :
 * - ATL (Fatigue aiguë 7 jours)
 * - CTL (Condition chronique 42 jours)
 * - TSB (Forme = CTL - ATL)
 * - ReadinessScore (0-100, pondère sommeil & HRV — RILES-026)
 *
 * IMPORTANT (RILES-020) : cet EWMA doit avancer **une fois par jour civil**,
 * avec `todayTss = 0` les jours sans séance. Voir `replayBanisterDaily`.
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
  const sleepScore =
    typeof currentAtlOrObj === "number"
      ? undefined
      : currentAtlOrObj.sleepScore;
  const hrvStatus =
    typeof currentAtlOrObj === "number" ? undefined : currentAtlOrObj.hrvStatus;

  const atlFatigue = Number(
    (currentAtl + (sessionTss - currentAtl) / 7).toFixed(1),
  );
  const ctlFitness = Number(
    (currentCtl + (sessionTss - currentCtl) / 42).toFixed(1),
  );
  const tsbForm = Number((ctlFitness - atlFatigue).toFixed(1));
  const readinessScore = computeReadinessScore(tsbForm, sleepScore, hrvStatus);

  return { atlFatigue, ctlFitness, tsbForm, readinessScore };
}

/**
 * Interpréte un tableau de dateKeys "YYYY-MM-DD" en nombres de jours civils
 * (algorithme civil de Howard Hinnant) — sans `new Date()` pour rester pur et
 * déterministe (frontière du module, issue #28).
 */
function dateKeyToDayNumber(dateKey: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ""));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  // Hinnant's days_from_civil
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/**
 * Étale les charges journalières sur **tous les jours civils** compris entre
 * la première et la dernière date d'activité : les jours sans séance reçoivent
 * une charge de 0 mais subissent bien la décroissance exponentielle (RILES-020).
 */
export function buildDailyTssSeries(entries: DailyTssEntry[]): number[] {
  const byDay = new Map<number, number>();
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const e of entries) {
    const dn = dateKeyToDayNumber(e.dateKey);
    if (dn === null) continue;
    byDay.set(dn, (byDay.get(dn) || 0) + (e.tss || 0));
    if (dn < min) min = dn;
    if (dn > max) max = dn;
  }

  const series: number[] = [];
  if (!Number.isFinite(min)) return series;
  for (let dn = min; dn <= max; dn++) {
    series.push(byDay.get(dn) || 0);
  }
  return series;
}

/**
 * Rejoue le modèle de Banister **une fois par jour civil** (RILES-020) :
 * `days` est la charge TSS de chaque jour, dans l'ordre chronologique, avec
 * un entrée par jour — y compris les jours de repos (tss 0).
 *
 * `steps` est toujours égal à `days.length` : le replay de 180 jours comporte
 * exactement 180 pas (critère d'acceptation RILES-020).
 */
export function replayBanisterDaily(
  days: number[],
  options: { sleepScore?: number; hrvStatus?: string } = {},
): BanisterReplayResult {
  let atl = 0;
  let ctl = 0;
  let result: BanisterLoadResult = updateBanisterLoad({
    previousAtl: atl,
    previousCtl: ctl,
    todayTss: 0,
  });

  for (const tss of days) {
    result = updateBanisterLoad({
      previousAtl: atl,
      previousCtl: ctl,
      todayTss: tss,
      sleepScore: options.sleepScore,
      hrvStatus: options.hrvStatus,
    });
    atl = result.atlFatigue;
    ctl = result.ctlFitness;
  }

  return { ...result, steps: days.length };
}

/**
 * Garde-fou d'entraînement (RILES-023) : une semaine proposée ne peut pas
 * dépasser +10 % au-dessus de la référence (moyenne des 4 dernières semaines).
 * Les baisses de volume restent libres (l'athlète a demandé un allègement).
 */
export const WEEKLY_VOLUME_RAMP_CAP = 0.1;

export function clampWeeklyVolumeRamp(
  proposedKm: number,
  referenceKm: number,
  cap: number = WEEKLY_VOLUME_RAMP_CAP,
): { km: number; clamped: boolean } {
  if (!referenceKm || referenceKm <= 0 || proposedKm <= referenceKm) {
    return { km: proposedKm, clamped: false };
  }
  const maxKm = referenceKm * (1 + cap);
  if (proposedKm > maxKm) {
    return { km: Number(maxKm.toFixed(1)), clamped: true };
  }
  return { km: proposedKm, clamped: false };
}
