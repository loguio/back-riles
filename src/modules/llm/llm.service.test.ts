import { LlmService } from "./llm.service";
import { AthleteTrainingContextDto } from "./dto/llm.dto";

/**
 * LlmService holds a large amount of pure, deterministic domain logic
 * (medical red flags, goal eligibility, pace calculation, life-rule parsing).
 * These tests instantiate the service directly with a stubbed ConfigService:
 * no Nest module, no Prisma, no network, no LLM call.
 */
function createService(
  env: Record<string, string | undefined> = {},
): LlmService {
  const configStub = {
    get: (key: string) => env[key],
  } as any;
  return new LlmService(configStub);
}

describe("LlmService.checkMedicalRedFlags", () => {
  const service = createService();

  it("flags a cardiovascular/neurological symptom as an emergency", () => {
    const result = service.checkMedicalRedFlags(
      "J'ai une douleur thoracique quand je cours vite",
    );

    expect(result.isRedFlag).toBe(true);
    expect(result.reason).toBe("cardiac_or_neuro_symptom");
    expect(result.emergencyReply).toContain("arrêt immédiat");
  });

  it("flags an acute musculoskeletal injury as an emergency", () => {
    const result = service.checkMedicalRedFlags(
      "Je pense que j'ai une entorse au genou après la séance",
    );

    expect(result.isRedFlag).toBe(true);
    expect(result.reason).toBe("acute_musculoskeletal_injury");
  });

  it("does not flag an ordinary training question", () => {
    const result = service.checkMedicalRedFlags(
      "Comment ajuster mon allure pour un semi-marathon dans 12 semaines ?",
    );

    expect(result.isRedFlag).toBe(false);
    expect(result.reason).toBeUndefined();
    expect(result.emergencyReply).toBeUndefined();
  });
});

describe("LlmService.evaluateGoalEligibility", () => {
  const service = createService();

  it("refuses an ultra with proof of a dangerous volume gap", () => {
    const context: AthleteTrainingContextDto = {
      hasSyncedHistory: true,
      recentWeeklyKm: 20,
      longestRecentRunKm: 12,
    };

    const result = service.evaluateGoalEligibility(
      "Je veux courir un ultra 100 km dans 8 semaines",
      context,
    );

    expect(result.status).toBe("UNREALISTIC_DANGEROUS");
    expect(result.isRealistic).toBe(false);
    expect(result.suggestedAlternative).toBeDefined();
  });

  it("accepts a goal outright when the athlete declares they are already in prep", () => {
    const result = service.evaluateGoalEligibility(
      "Je suis déjà en prépa pour un marathon dans 4 mois",
    );

    expect(result.status).toBe("ELIGIBLE");
    expect(result.isRealistic).toBe(true);
  });

  it("never blocks a short goal asked before any history is synced", () => {
    const result = service.evaluateGoalEligibility("Je veux courir 10 km");

    expect(result.status).toBe("ELIGIBLE");
    expect(result.pedagogicalMessage).toContain("12 semaines");
  });
});

describe("LlmService.computePacesFromRecentPerformance", () => {
  it("falls back to the default baseline when no training context exists", () => {
    const paces = createService().computePacesFromRecentPerformance();

    expect(paces.calibrationSource).toBe("default_baseline");
    expect(paces.thresholdPaceZ4).toBe("4:52/km");
    expect(paces.easyPaceZ2).toBe("5:45/km – 6:05/km");
  });

  it("calibrates paces from recent sessions with heart rate", () => {
    const context: AthleteTrainingContextDto = {
      hrMax: 180,
      recentSessions: [
        {
          avgPaceSecPerKm: 240,
          avgHeartRate: 160,
          maxHeartRate: 175,
          distanceKm: 10,
        },
      ],
    };

    const paces = createService().computePacesFromRecentPerformance(context);

    expect(paces.calibrationSource).toBe("recent_sessions_hr");
    expect(paces.thresholdPaceZ4).toBe("4:03/km");
    expect(paces.easyPaceZ2).toBe("4:51/km – 5:11/km");
    expect(paces.targetRacePace).toBe("4:11/km");
  });

  it("uses imported watch threshold zones with highest priority", () => {
    const context: AthleteTrainingContextDto = {
      importedThresholdPaceSecPerKm: 300,
      importedEasyPaceSecPerKm: 360,
    };

    const paces = createService().computePacesFromRecentPerformance(context);

    expect(paces.calibrationSource).toBe("watch_zones");
    expect(paces.thresholdPaceZ4).toBe("5:00/km");
    expect(paces.intervalPaceZ5).toBe("4:38/km");
  });
});

describe("LlmService.extractRulesDeterministically", () => {
  const service = createService();

  it("extracts sanctuarized training days from a free-text message", () => {
    const rules = service.extractRulesDeterministically(
      "Je ne cours jamais le lundi et je suis indisponible le mercredi",
    );

    const daysRule = rules.find((r) => r.title === "Jours sanctuarisés");
    expect(daysRule).toBeDefined();
    expect(daysRule?.description).toContain("lundi, mercredi");
  });

  it("extracts injury prevention and weekly frequency as separate rules", () => {
    const rules = service.extractRulesDeterministically(
      "Fais attention à mon genou, maximum 3 séances par semaine",
    );

    expect(rules.map((r) => r.title)).toEqual([
      "Prévention & Progressivité",
      "Fréquence hebdomadaire",
    ]);
    expect(rules[1].description).toContain("3 séances par semaine");
  });

  it("returns no rule when the message carries no constraint", () => {
    expect(
      service.extractRulesDeterministically("Merci pour la séance d'hier !"),
    ).toEqual([]);
  });
});

describe("RILES-029 — buildCompactAthleteMarkdownContext sans données fabriquées", () => {
  const service = createService();
  const paces = {
    easyPaceZ2: "5:45/km",
    marathonPaceZ3: "5:10/km",
    thresholdPaceZ4: "4:45/km",
    intervalPaceZ5: "4:20/km",
    targetRacePace: "4:40/km",
  };

  it("déclare explicitement les données absentes au lieu d'inventer des valeurs", () => {
    const ctx: any = {
      activeGoalTitle: "",
      rules: [],
      trainingContext: {},
    };
    const prompt = service.buildCompactAthleteMarkdownContext(ctx, paces);

    expect(prompt).toContain("Durée de préparation non renseignée");
    expect(prompt).toContain("Non déterminé (aucune donnée de volume");
    expect(prompt).toContain("Non mesurée (aucune séance synchronisée");
    // Aucun default fabriqué ni macrocycle inventé
    expect(prompt).not.toContain("reste ~8 semaines");
    expect(prompt).not.toContain("MACROCYCLE");
    expect(prompt).not.toContain("TSB (Forme) 6");
    expect(prompt).not.toContain("ATL (Fatigue) 42");
    expect(prompt).not.toContain("CTL (Fitness) 48");
  });

  it("reflète les valeurs réelles de la base quand elles existent", () => {
    const ctx: any = {
      activeGoalTitle: "Semi-marathon",
      activeGoalWeeksRemaining: 12,
      totalKm: 48,
      activeWeeks: 4,
      atlFatigue: 40,
      ctlFitness: 45,
      tsbForm: 5,
      rules: [],
      trainingContext: { recentWeeklyKm: 42 },
    };
    const prompt = service.buildCompactAthleteMarkdownContext(ctx, paces);

    expect(prompt).toContain("reste ~12 semaines");
    expect(prompt).toContain("~42 km/semaine");
    expect(prompt).toContain(
      "TSB (Forme) 5 | ATL (Fatigue) 40 | CTL (Fitness) 45",
    );
    expect(prompt).not.toContain("MACROCYCLE");
  });
});

describe("RILES-028 — buildConversationHistorySection (fenêtre bornée)", () => {
  const service = createService();

  it("retourne une chaîne vide sans historique", () => {
    expect(service.buildConversationHistorySection(undefined)).toBe("");
    expect(service.buildConversationHistorySection([])).toBe("");
  });

  it("n'inclut que les 12 derniers messages, chronologiques et tronqués", () => {
    const history = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `message-${i}`,
    }));
    const section = service.buildConversationHistorySection(history);

    expect(section).not.toContain("message-7]"); // ancien message écarté
    expect(section).toContain("message-19");
    expect(section).toContain("- Utilisateur : message-8");
    // Ordre chronologique : le plus ancien conservé en premier
    const firstIdx = section.indexOf("message-8");
    const lastIdx = section.indexOf("message-19");
    expect(firstIdx).toBeGreaterThan(-1);
    expect(firstIdx).toBeLessThan(lastIdx);
  });

  it("tronque les messages trop longs à 400 caractères", () => {
    const section = service.buildConversationHistorySection([
      { role: "user", text: "x".repeat(1000) },
    ]);
    expect(section).toContain(`${"x".repeat(400)}…`);
    expect(section).not.toContain("x".repeat(401));
  });
});
