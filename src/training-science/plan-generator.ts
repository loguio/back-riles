/**
 * Training-science core — pure domain functions (RILES-035 / issue #28).
 *
 * Boundaries: this module imports NOTHING from NestJS, Prisma, or the LLM
 * provider layer. No I/O, no `Date.now()`, no randomness — same inputs always
 * produce the same outputs, which is what makes the science falsifiable.
 */
import { getEasySinglePace } from "./paces";
import {
  GeneratedPlanWorkout,
  LifeRule,
  MultiWeekPlanResult,
  PeriodizationPlanInput,
  PeriodizedWeekMetrics,
  PlanCalendarSlot,
  TargetPaces,
} from "./types";

/**
 * Détecte les jours de la semaine verrouillés dans les LifeRules de l'utilisateur
 */
export function getLockedDayNamesFromRules(lifeRules: LifeRule[]): Set<string> {
  const lockedShortDays = new Set<string>();

  const mapDayToShort: Record<string, string> = {
    lundi: "Lun",
    mardi: "Mar",
    mercredi: "Mer",
    jeudi: "Jeu",
    vendredi: "Ven",
    samedi: "Sam",
    dimanche: "Dim",
  };

  for (const rule of lifeRules) {
    const text = `${rule.title || ""} ${rule.description || ""}`.toLowerCase();
    // Ignore les règles qui décrivent la date de la course ou un objectif positif (ex: "Course prévue le troisième samedi de février", "Sortie longue le dimanche")
    if (
      text.includes("échéance") ||
      text.includes("course prévue") ||
      text.includes("compétition") ||
      text.includes("sortie longue le")
    ) {
      continue;
    }

    const isBlockingConstraint =
      text.includes("bloqu") ||
      text.includes("indisponible") ||
      text.includes("aucune séance") ||
      text.includes("pas courir") ||
      text.includes("pas dispo") ||
      text.includes("jamais") ||
      text.includes("repos") ||
      text.includes("impossible") ||
      text.includes("sanctuaris") ||
      text.includes("occupé");

    if (!isBlockingConstraint) continue;

    for (const [fullDay, shortDay] of Object.entries(mapDayToShort)) {
      if (text.includes(fullDay)) {
        lockedShortDays.add(shortDay);
      }
    }
  }
  return lockedShortDays;
}

/**
 * Démarrage adapté et progressif : ~80-85% du volume habituel pour commencer en douceur.
 * Si habitué à 25-30 km, on démarre à ~22-24 km (pas à 40 km d'entrée de jeu, ni à un niveau ridicule).
 */
export function deriveStartWeeklyKm(baseRecentKm: number): number {
  return Math.max(18, Math.min(30, Math.round(baseRecentKm * 0.82)));
}

// Modèle physiologique de périodisation 3:1 avec règle des 10 %
export function computePeriodizedWeekMetrics(
  weekIndex: number,
  totalWeeks: number,
  startWeeklyKm: number,
): PeriodizedWeekMetrics {
  const isTapering = weekIndex >= totalWeeks - 2 && totalWeeks >= 8;
  if (isTapering) {
    const peakCycleIdx = Math.floor((totalWeeks - 3) / 4);
    const peakVolume = Math.round(
      startWeeklyKm * Math.pow(1.15, peakCycleIdx) * 1.21,
    );
    const taperRatio = weekIndex === totalWeeks - 1 ? 0.55 : 0.75;
    return {
      targetKm: Math.round(peakVolume * taperRatio),
      isDeload: false,
      isTaper: true,
      phaseLabel: "Affûtage",
    };
  }

  const cycleIndex = Math.floor(weekIndex / 4);
  const posInCycle = weekIndex % 4; // 0, 1, 2 = montée ; 3 = deload

  const cycleBase = startWeeklyKm * Math.pow(1.15, cycleIndex);

  if (posInCycle === 0) {
    return {
      targetKm: Math.round(cycleBase),
      isDeload: false,
      isTaper: false,
      phaseLabel: cycleIndex === 0 ? "Socle Aérobie" : "Développement Seuil",
    };
  } else if (posInCycle === 1) {
    return {
      targetKm: Math.round(cycleBase * 1.1), // +10%
      isDeload: false,
      isTaper: false,
      phaseLabel: "Montée de Charge (+10 %)",
    };
  } else if (posInCycle === 2) {
    return {
      targetKm: Math.round(cycleBase * 1.21), // +10% supplémentaire
      isDeload: false,
      isTaper: false,
      phaseLabel: "Pic de Bloc (+10 %)",
    };
  } else {
    return {
      targetKm: Math.round(cycleBase * 1.21 * 0.78), // Deload -22%
      isDeload: true,
      isTaper: false,
      phaseLabel: "Assimilation (Deload -22 %)",
    };
  }
}

export function buildDistinctWeekIndex(
  slots: PlanCalendarSlot[],
): Map<string, number> {
  const distinctWeekMap = new Map<string, number>();
  slots.forEach((s) => {
    const key = `${s.year}-${s.weekNumber}`;
    if (!distinctWeekMap.has(key)) {
      distinctWeekMap.set(key, distinctWeekMap.size);
    }
  });
  return distinctWeekMap;
}

export function normalizeGeneratedWorkout(
  slot: PlanCalendarSlot,
  raw: any,
  lockedDays: Set<string>,
  paces: TargetPaces,
): GeneratedPlanWorkout {
  const isLockedByRule = lockedDays.has(slot.dayName);
  const isRest = isLockedByRule || Boolean(raw?.isRestDay);

  if (isRest) {
    return {
      ...slot,
      timeLabel: "Jour de repos",
      isRestDay: true,
      category: "RÉCUPÉRATION & ASSIMILATION",
      title: isLockedByRule
        ? `Jour de repos (${slot.dayName})`
        : raw?.title || "Jour de repos",
      duration: "—",
      distance: "0 km",
      targetPace: "—",
      targetZoneLabel: "Zone 1",
      targetZoneBpm: "< 110 bpm",
      targetZoneSegments: [{ color: "#93C5FD", flex: 1 }],
      pinPositionPercent: 10,
      effortBlocks: [
        {
          title: "Repos",
          durationLabel: "Journée complète",
          type: "recovery",
          flexRatio: 1,
        },
      ],
      tags: isLockedByRule
        ? ["Contrainte respectée", "Repos"]
        : ["Récupération", "Hydratation"],
      aiAdjustmentNote: isLockedByRule
        ? `Contrainte appliquée : aucune séance programmée le ${slot.dayName.toLowerCase()}.`
        : raw?.aiAdjustmentNote ||
          "Journée d'assimilation physiologique pour consolider tes progrès.",
      tss: 0,
    };
  }

  const easySinglePace = getEasySinglePace(paces);
  const category = raw?.category || "ENDURANCE FONDAMENTALE";
  const isQuality =
    category.includes("QUALITATIVE") ||
    category.includes("SEUIL") ||
    category.includes("SPÉCIFIQUE");

  return {
    ...slot,
    timeLabel: raw?.timeLabel || "18:30",
    isRestDay: false,
    category,
    title: raw?.title || "Footing Endurance Fondamentale",
    duration: raw?.duration || "45 min",
    distance: raw?.distance || "8,0 km",
    targetPace:
      raw?.targetPace || (isQuality ? paces.thresholdPaceZ4 : easySinglePace),
    targetZoneLabel:
      raw?.targetZoneLabel || (isQuality ? "Zone 3–4" : "Zone 2"),
    targetZoneBpm:
      raw?.targetZoneBpm || (isQuality ? "160–172 bpm" : "135–148 bpm"),
    targetZoneSegments: isQuality
      ? [
          { color: "#93C5FD", flex: 1.2 },
          { color: "#FBBF24", flex: 2 },
          { color: "#FC4C02", flex: 2 },
        ]
      : [
          { color: "#93C5FD", flex: 2 },
          { color: "#34D399", flex: 4 },
          { color: "#FBBF24", flex: 1 },
        ],
    pinPositionPercent: raw?.pinPositionPercent ?? (isQuality ? 68 : 38),
    effortBlocks:
      Array.isArray(raw?.effortBlocks) && raw.effortBlocks.length > 0
        ? raw.effortBlocks
        : [
            {
              title: "Échauffement",
              durationLabel: "15 min",
              type: "warmup",
              flexRatio: 1,
            },
            {
              title: isQuality ? "Bloc Seuil" : "Endurance Z2",
              durationLabel: "25 min",
              type: isQuality ? "threshold" : "interval",
              flexRatio: 2,
            },
            {
              title: "Retour au calme",
              durationLabel: "5 min",
              type: "cooldown",
              flexRatio: 1,
            },
          ],
    tags:
      Array.isArray(raw?.tags) && raw.tags.length > 0
        ? raw.tags
        : [
            raw?.distance || "8,0 km",
            `Allure : ${raw?.targetPace || easySinglePace}`,
            raw?.targetZoneLabel || "Zone 2",
          ],
    aiAdjustmentNote:
      raw?.aiAdjustmentNote ||
      `Séance calibrée sur tes vraies allures récentes (${isQuality ? paces.thresholdPaceZ4 : easySinglePace}).`,
    tss: raw?.tss ?? (isQuality ? 68 : 42),
  };
}

export function generatePeriodizedMultiWeekFallback(
  input: PeriodizationPlanInput,
  lockedDays: Set<string>,
  paces: TargetPaces,
  modelName: string,
): MultiWeekPlanResult {
  const easySinglePace = getEasySinglePace(paces);
  const slots: any[] = input.calendarSlots || [];

  // Indexation chronologique des semaines uniques (gère l'enjambement d'années)
  const distinctWeekMap = buildDistinctWeekIndex(slots);
  const totalWeeks = Math.max(1, distinctWeekMap.size);

  const baseRecentKm =
    input.sixMonthsStravaSummary?.recent4WeeksAvgKm ||
    input.physiologicalState?.recentWeeklyKm ||
    28;
  // Démarrage adapté et progressif : ~80-85% du volume habituel pour commencer en douceur
  // Si habitué à 25-30 km, on démarre à ~22-24 km (pas à 40 km d'entrée de jeu, ni à un niveau ridicule)
  const startWeeklyKm = deriveStartWeeklyKm(baseRecentKm);

  const workouts = slots.map((slot) => {
    const key = `${slot.year}-${slot.weekNumber}`;
    const weekIndex = distinctWeekMap.get(key) || 0;
    const { targetKm, isDeload, isTaper } = computePeriodizedWeekMetrics(
      weekIndex,
      totalWeeks,
      startWeeklyKm,
    );

    if (lockedDays.has(slot.dayName)) {
      return normalizeGeneratedWorkout(
        slot,
        { isRestDay: true },
        lockedDays,
        paces,
      );
    }

    if (slot.dayName === "Lun") {
      // Footing Z2 : ~22% du volume hebdo
      const distNum = Math.max(4.0, Number((targetKm * 0.22).toFixed(1)));
      const dist = distNum.toFixed(1).replace(".", ",");
      const dur = Math.round(distNum * 5.8);
      return normalizeGeneratedWorkout(
        slot,
        {
          timeLabel: "18:00",
          isRestDay: false,
          category: "ENDURANCE FONDAMENTALE",
          title: isDeload
            ? `Footing Régénération Z2 (${dist} km)`
            : `Footing Fondamental Z2 (${dist} km)`,
          duration: `${dur} min`,
          distance: `${dist} km`,
          targetPace: easySinglePace,
          targetZoneLabel: "Zone 2",
          targetZoneBpm: "134–146 bpm",
          pinPositionPercent: 35,
          tags: [`${dist} km`, `Allure : ${easySinglePace}`, "Zone 2"],
          aiAdjustmentNote: isDeload
            ? "Semaine d'assimilation : footing léger pour régénérer les fibres musculaires."
            : `Séance aérobie calibrée sur ton socle (volume hebdo visé : ${targetKm} km).`,
          tss: Math.round(distNum * 5.2),
        },
        lockedDays,
        paces,
      );
    }

    if (slot.dayName === "Mar") {
      return normalizeGeneratedWorkout(
        slot,
        {
          timeLabel: "18:30",
          isRestDay: false,
          category: "RENFORCEMENT & MOBILITÉ",
          title: "Gainage, Proprioception & Prévention Mollets",
          duration: "35 min",
          distance: "0 km",
          targetPace: "—",
          targetZoneLabel: "Zone 1–2",
          targetZoneBpm: "110–132 bpm",
          pinPositionPercent: 25,
          tags: ["35 min", "Prévention blessure", "Zone 1"],
          aiAdjustmentNote:
            "Renforcement ciblé pour absorber la montée de charge sans fatigue tendineuse.",
          tss: 22,
        },
        lockedDays,
        paces,
      );
    }

    if (slot.dayName === "Mer") {
      // Seuil Z4 : ~26% du volume hebdo
      const distNum = Math.max(5.0, Number((targetKm * 0.26).toFixed(1)));
      const dist = distNum.toFixed(1).replace(".", ",");
      const reps = isDeload ? 2 : Math.min(4, 2 + Math.floor(weekIndex / 3));
      const repMins = isDeload ? 6 : 8;
      return normalizeGeneratedWorkout(
        slot,
        {
          timeLabel: "18:30",
          isRestDay: false,
          category: "SÉANCE QUALITATIVE",
          title: isDeload
            ? `Rappel Seuil Allégé ${reps} × ${repMins} min (${dist} km)`
            : `Séance Seuil ${reps} × ${repMins} min (${dist} km)`,
          duration: `${Math.round(distNum * 5.6)} min`,
          distance: `${dist} km`,
          targetPace: paces.thresholdPaceZ4,
          targetZoneLabel: "Zone 3–4",
          targetZoneBpm: "160–173 bpm",
          pinPositionPercent: 68,
          tags: [`${dist} km`, `Seuil : ${paces.thresholdPaceZ4}`, "Zone 3/4"],
          aiAdjustmentNote: isDeload
            ? "Volume et fractions allégés pour assimiler sans accumuler de fatigue."
            : `Séance clé au seuil (${paces.thresholdPaceZ4}) pour repousser l'acidose lactique.`,
          tss: Math.round(distNum * 6.5),
        },
        lockedDays,
        paces,
      );
    }

    if (slot.dayName === "Jeu") {
      return normalizeGeneratedWorkout(
        slot,
        { isRestDay: true },
        lockedDays,
        paces,
      );
    }

    if (slot.dayName === "Ven") {
      // Allure Spécifique Marathon Z3 : ~18% du volume hebdo
      const distNum = Math.max(4.0, Number((targetKm * 0.18).toFixed(1)));
      const dist = distNum.toFixed(1).replace(".", ",");
      return normalizeGeneratedWorkout(
        slot,
        {
          timeLabel: "12:30",
          isRestDay: false,
          category: "ALLURE SPÉCIFIQUE",
          title: isTaper
            ? `Footing d'Affûtage & Lignes Droites (${dist} km)`
            : `Footing Progressif & Allure Cible (${dist} km)`,
          duration: `${Math.round(distNum * 5.7)} min`,
          distance: `${dist} km`,
          targetPace: paces.marathonPaceZ3,
          targetZoneLabel: "Zone 3",
          targetZoneBpm: "150–162 bpm",
          pinPositionPercent: 56,
          tags: [`${dist} km`, `Allure : ${paces.marathonPaceZ3}`, "Zone 3"],
          aiAdjustmentNote: isTaper
            ? "Maintien du tonus neuro-musculaire sans entamer les réserves."
            : "Travail d'économie de course à allure cible avant la sortie longue.",
          tss: Math.round(distNum * 5.5),
        },
        lockedDays,
        paces,
      );
    }

    if (slot.dayName === "Sam") {
      // Sortie Longue Z2 : ~34% du volume hebdo
      const distNum = Math.max(7.0, Number((targetKm * 0.34).toFixed(1)));
      const dist = distNum.toFixed(1).replace(".", ",");
      const mins = Math.round(distNum * 5.9);
      const h = Math.floor(mins / 60);
      const m = mins % 60;
      return normalizeGeneratedWorkout(
        slot,
        {
          timeLabel: "09:00",
          isRestDay: false,
          category: "SORTIE LONGUE",
          title: isDeload
            ? `Sortie Longue d'Assimilation (${dist} km)`
            : `Sortie Longue Progressive (${dist} km)`,
          duration:
            h > 0 ? `${h}h${String(m).padStart(2, "0")}` : `${mins} min`,
          distance: `${dist} km`,
          targetPace: easySinglePace,
          targetZoneLabel: "Zone 2",
          targetZoneBpm: "136–150 bpm",
          pinPositionPercent: 45,
          tags: [`${dist} km`, `Endurance : ${easySinglePace}`, "Zone 2"],
          aiAdjustmentNote: isDeload
            ? "Volume réduit de ~22 % : assimilation physiologique et surcompensation."
            : `Sortie pilier du week-end (+10 % hebdo respecté, volume cible : ${targetKm} km).`,
          tss: Math.round(distNum * 5.8),
        },
        lockedDays,
        paces,
      );
    }

    return normalizeGeneratedWorkout(
      slot,
      {
        isRestDay: true,
        title: "Repos complet & Bilan de Semaine",
      },
      lockedDays,
      paces,
    );
  });

  const lockedInfo =
    lockedDays.size > 0
      ? `Tes jours réservés (${Array.from(lockedDays).join(", ")}) sont programmés en repos selon tes contraintes.`
      : "Tes règles de vie sont intégrées sur chaque semaine.";

  const strava6m = input.sixMonthsStravaSummary;
  const stravaContextNote = strava6m
    ? `Basé sur tes 6 derniers mois Strava (${strava6m.totalActivities} séances • ${strava6m.totalDistanceKm} km cumulés • ${strava6m.recent4WeeksAvgKm} km/sem sur le dernier mois • sortie longue max ${strava6m.longestRunKm} km). `
    : "";

  return {
    planSummary: `Plan multi-semaines (${distinctWeekMap.size} semaines) généré pour « ${input.userProfile.activeGoalTitle} (${input.userProfile.activeGoalTarget}) ». ${stravaContextNote}Allures calibrées sur tes vraies séances & FC (Z2 : ${paces.easyPaceZ2}, Seuil : ${paces.thresholdPaceZ4}). ${lockedInfo}`,
    modelUsed: `${modelName}-periodized-engine`,
    workouts,
  };
}
