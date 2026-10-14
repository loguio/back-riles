import "reflect-metadata";
import { LlmService } from "./llm.service";

/**
 * RILES-011 — Frontière modèle / application.
 *
 * `callOpenAiCompatibleJson` renvoyait le JSON du modèle avec un simple cast :
 * toute sortie (champs inventés, type d'action inconnu, dateKeys arbitraires)
 * était retournée telle quelle au coach, qui l'écrivait en base.
 *
 * Ici on vérifie que le modèle ne peut plus rien faire passer au travers :
 * sortie hors schéma ou malformée => rejetée, et `generateCoachReply` bascule
 * sur le moteur hybride local déterministe (aucune écriture dérivée du
 * modèle).
 */

function createService(
  env: Record<string, string | undefined> = {},
): LlmService {
  const configStub = {
    get: (key: string) => env[key],
  } as any;
  return new LlmService(configStub);
}

const athleteContext = {
  userName: "l'athlète",
  rules: [],
  trainingContext: {},
  todayDate: "2026-10-14",
  currentWeekWorkouts: [],
} as any;

const USER_PROMPT = "Je suis crevé ce soir, tu peux alléger ma séance ?";

function mockModelReply(service: LlmService, reply: unknown) {
  return jest
    .spyOn(service as any, "callOpenAiCompatibleJson")
    .mockResolvedValue(reply as any);
}

describe("RILES-011 LlmService.generateCoachReply — sorties modèle validées", () => {
  it("rejette une sortie qui tente de supprimer la semaine et bascule sur le moteur local", async () => {
    const service = createService({ LLM_API_KEY: "test-key" });
    const spy = mockModelReply(service, {
      replyText: "J'ai supprimé ta semaine comme demandé.",
      safetyStatus: "safe",
      suggestedAction: {
        type: "delete_all_workouts",
        label: "Semaine supprimée",
        applied: true,
        details: "wipe_week",
      },
      recalculatedWeekWorkouts: [
        {
          dateKey: "2019-01-01",
          title: "ANNULATION TOTALE",
          duration: "—",
          distance: "0 km",
        },
      ],
      injectedField: true,
    });

    const out = await service.generateCoachReply({
      userPrompt: USER_PROMPT,
      athleteContext,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    // Rejet => repli sur le moteur hybride déterministe local
    expect(out.modelUsed).toBe("hybrid-rule-engine");
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("delete_all_workouts");
    expect(serialized).not.toContain("wipe_week");
    expect(serialized).not.toContain("ANNULATION TOTALE");
    expect(serialized).not.toContain("2019-01-01");
    expect(serialized).not.toContain("injectedField");
  });

  it("rejette un JSON syntaxiquement valide contenant un champ inconnu", async () => {
    const service = createService({ LLM_API_KEY: "test-key" });
    mockModelReply(service, {
      replyText: "Voilà ton ajustement.",
      safetyStatus: "safe",
      adminOverride: true,
    });

    const out = await service.generateCoachReply({
      userPrompt: USER_PROMPT,
      athleteContext,
    });

    expect(out.modelUsed).toBe("hybrid-rule-engine");
    expect(JSON.stringify(out)).not.toContain("adminOverride");
  });

  it("rejette une sortie de modèle malformée (échec de JSON.parse côté modèle)", async () => {
    const service = createService({ LLM_API_KEY: "test-key" });
    jest
      .spyOn(service as any, "callOpenAiCompatibleJson")
      .mockRejectedValue(new SyntaxError("Unexpected token } in JSON"));

    const out = await service.generateCoachReply({
      userPrompt: USER_PROMPT,
      athleteContext,
    });

    expect(out.modelUsed).toBe("hybrid-rule-engine");
    expect(typeof out.replyText).toBe("string");
    expect(out.replyText.length).toBeGreaterThan(0);
  });

  it("accepte et normalise une sortie de modèle conforme au schéma", async () => {
    const service = createService({ LLM_API_KEY: "test-key" });
    mockModelReply(service, {
      replyText: "Allègement appliqué, tiens ton rythme.",
      reformulatedIntent: "Fatigue du soir",
      safetyStatus: "warning_fatigue",
      suggestedAction: {
        type: "reduce_intensity",
        label: "Séance allégée",
        applied: true,
        details: "lighten",
      },
      recalculatedWeekWorkouts: [
        {
          dateKey: "2026-10-15",
          isRestDay: false,
          category: "ENDURANCE FONDAMENTALE",
          title: "Footing léger",
          duration: "35 min",
          distance: "6,0 km",
          targetPace: "5:45/km",
          targetZoneLabel: "Zone 2",
          targetZoneBpm: "135–148 bpm",
          aiAdjustmentNote: "Séance allégée.",
          tags: ["6,0 km", "35 min"],
        },
      ],
    });

    const out = await service.generateCoachReply({
      userPrompt: USER_PROMPT,
      athleteContext,
    });

    expect(out.modelUsed).toBe("gemini-3.5-flash-lite");
    expect(out.replyText).toBe("Allègement appliqué, tiens ton rythme.");
    expect(out.safetyStatus).toBe("warning_fatigue");
    expect(out.suggestedAction?.type).toBe("reduce_intensity");
    expect(out.recalculatedWeekWorkouts).toHaveLength(1);
    expect(out.recalculatedWeekWorkouts?.[0].dateKey).toBe("2026-10-15");
  });

  it("reste déterministe et sûr sans clé LLM configurée", async () => {
    const service = createService();

    const out = await service.generateCoachReply({
      userPrompt: USER_PROMPT,
      athleteContext,
    });

    expect(out.modelUsed).toBe("hybrid-rule-engine");
    expect(typeof out.replyText).toBe("string");
  });
});
