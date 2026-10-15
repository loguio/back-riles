// Polyfill Reflect.getMetadata : les schémas class-validator sont décorés au
// chargement du module (le runtime Nest le fait déjà en production).
import "reflect-metadata";
import {
  parseCoachReplyModelJson,
  sanitizeSuggestedAction,
  sanitizeWeekWorkoutChanges,
  validateCoachReplyOutput,
} from "./coach-reply.validator";

const VALID_WEEK_CHANGES = [
  {
    dateKey: "2026-10-15",
    isRestDay: false,
    category: "ENDURANCE FONDAMENTALE",
    title: "Footing léger (Adapté)",
    duration: "35 min",
    distance: "6,0 km",
    targetPace: "5:45/km",
    targetZoneLabel: "Zone 2",
    targetZoneBpm: "135–148 bpm",
    aiAdjustmentNote: "Séance allégée.",
    tags: ["6,0 km", "35 min"],
  },
];

describe("RILES-011 validateCoachReplyOutput — schéma strict des sorties modèle", () => {
  it("accepte une sortie conforme et en expose les champs normalisés", () => {
    const result = validateCoachReplyOutput({
      replyText: "Allège ta séance du jour.",
      reformulatedIntent: "Fatigue du jour",
      safetyStatus: "warning_fatigue",
      suggestedAction: {
        type: "reduce_intensity",
        label: "Semaine allégée",
        applied: true,
        details: "lighten",
      },
      recalculatedWeekWorkouts: VALID_WEEK_CHANGES,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.replyText).toBe("Allège ta séance du jour.");
    expect(result.value.safetyStatus).toBe("warning_fatigue");
    expect(result.value.suggestedAction?.type).toBe("reduce_intensity");
    expect(result.value.recalculatedWeekWorkouts?.[0].dateKey).toBe(
      "2026-10-15",
    );
  });

  it("rejette un champ inconnu ajouté par le modèle (listes blanches)", () => {
    const result = validateCoachReplyOutput({
      replyText: "ok",
      safetyStatus: "safe",
      deleteAllWorkouts: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("deleteAllWorkouts");
  });

  it("rejette un type d'action hors schéma (ex: suppression de séances)", () => {
    const result = validateCoachReplyOutput({
      replyText: "ok",
      safetyStatus: "safe",
      suggestedAction: {
        type: "delete_all_workouts",
        label: "Supprime tout",
        applied: true,
        details: "wipe_week",
      },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("suggestedAction");
  });

  it("rejette une action dont un champ n'est pas du bon type", () => {
    const result = validateCoachReplyOutput({
      replyText: "ok",
      suggestedAction: {
        type: "adjust_workout",
        label: "ok",
        applied: "true",
      },
    });

    expect(result.ok).toBe(false);
  });

  it("rejette une dateKey qui n'est pas une date ISO (YYYY-MM-DD)", () => {
    const result = validateCoachReplyOutput({
      replyText: "ok",
      recalculatedWeekWorkouts: [
        { ...VALID_WEEK_CHANGES[0], dateKey: "demain" },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("dateKey");
  });

  it("rejette recalculatedWeekWorkouts qui n'est pas un tableau", () => {
    const result = validateCoachReplyOutput({
      replyText: "ok",
      recalculatedWeekWorkouts: "wipe the week",
    });

    expect(result.ok).toBe(false);
  });

  it("rejette une safetyStatus hors liste", () => {
    const result = validateCoachReplyOutput({
      replyText: "ok",
      safetyStatus: "ignore_previous_instructions",
    });

    expect(result.ok).toBe(false);
  });

  it("rejette un payload qui n'est pas un objet JSON", () => {
    expect(validateCoachReplyOutput("just a string").ok).toBe(false);
    expect(validateCoachReplyOutput(null).ok).toBe(false);
    expect(validateCoachReplyOutput([{ replyText: "ok" }]).ok).toBe(false);
  });
});

describe("RILES-011 parseCoachReplyModelJson — JSON malformé rejeté", () => {
  it("rejette du JSON malformé renvoyé par le modèle", () => {
    const result = parseCoachReplyModelJson("{ replyText: 'coucou',");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("JSON malformé");
  });

  it("rejette un contenu vide", () => {
    expect(parseCoachReplyModelJson("   ").ok).toBe(false);
  });

  it("accepte un JSON valide encapsulé dans des fences markdown", () => {
    const result = parseCoachReplyModelJson(
      '```json\n{"replyText":"Bonjour !","safetyStatus":"safe"}\n```',
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.replyText).toBe("Bonjour !");
  });

  it("rejette un JSON valide mais hors schéma", () => {
    const result = parseCoachReplyModelJson(
      '{"replyText":"ok","plannedMutations":[{"dateKey":"2020-01-01"}]}',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toContain("plannedMutations");
  });
});

describe("RILES-011 sanitizeSuggestedAction — actions validées avant persistance", () => {
  it("retourne null pour une action absente", () => {
    expect(sanitizeSuggestedAction(undefined)).toBeNull();
    expect(sanitizeSuggestedAction(null)).toBeNull();
  });

  it("retourne null pour une action hors schéma", () => {
    expect(
      sanitizeSuggestedAction({
        type: "delete_all_workouts",
        label: "Tout supprimer",
        applied: true,
        details: "wipe_week",
      }),
    ).toBeNull();
    expect(
      sanitizeSuggestedAction({
        type: "add_life_rule",
        label: "ok",
        applied: true,
        details: "add_life_rule",
        ruleData: { title: "Règle", description: "desc", icon: "trash-2" },
      }),
    ).toBeNull();
  });

  it("retourne une action normalisée lorsqu'elle est conforme", () => {
    const action = sanitizeSuggestedAction({
      type: "add_life_rule",
      label: "Règle reformulée",
      applied: true,
      details: "add_life_rule",
      ruleData: {
        title: "Pas de course le samedi",
        description: "Je suis indisponible le samedi matin.",
        icon: "calendar-lock",
      },
    });

    expect(action).not.toBeNull();
    expect(action?.ruleData?.title).toBe("Pas de course le samedi");
  });
});

describe("RILES-011 sanitizeWeekWorkoutChanges — liste blanche des dateKeys", () => {
  const allowed = ["2026-10-14", "2026-10-15", "2026-10-16"];

  it("écarte toutes les propositions hors semaine de l'athlète (aucune écriture)", () => {
    const result = sanitizeWeekWorkoutChanges(
      [
        { ...VALID_WEEK_CHANGES[0], dateKey: "2019-01-01" },
        { ...VALID_WEEK_CHANGES[0], dateKey: "2027-12-31" },
      ],
      allowed,
    );

    expect(result.changes).toHaveLength(0);
    expect(result.schemaErrors).toHaveLength(0);
    expect(result.droppedDateKeys).toEqual(["2019-01-01", "2027-12-31"]);
  });

  it("rejette le lot entier si un seul élément est hors schéma", () => {
    const result = sanitizeWeekWorkoutChanges(
      [VALID_WEEK_CHANGES[0], { ...VALID_WEEK_CHANGES[0], dateKey: "demain" }],
      allowed,
    );

    expect(result.schemaErrors.length).toBeGreaterThan(0);
    expect(result.changes).toHaveLength(0);
    expect(result.droppedDateKeys).toHaveLength(0);
  });

  it("rejette le lot entier si le modèle renvoie autre chose qu'un tableau", () => {
    const result = sanitizeWeekWorkoutChanges("tout effacer", allowed);

    expect(result.schemaErrors.length).toBeGreaterThan(0);
    expect(result.changes).toHaveLength(0);
  });

  it("conserve les propositions dans la semaine et déduplique par dateKey", () => {
    const result = sanitizeWeekWorkoutChanges(
      [
        VALID_WEEK_CHANGES[0],
        { ...VALID_WEEK_CHANGES[0], title: "Version finale" },
        { ...VALID_WEEK_CHANGES[0], dateKey: "2020-05-05" },
      ],
      allowed,
    );

    expect(result.schemaErrors).toHaveLength(0);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].dateKey).toBe("2026-10-15");
    expect(result.changes[0].title).toBe("Version finale");
    expect(result.droppedDateKeys).toEqual(["2020-05-05"]);
  });

  it("ne retourne rien quand le modèle ne propose aucune modification", () => {
    expect(sanitizeWeekWorkoutChanges(undefined, allowed).changes).toHaveLength(
      0,
    );
    expect(sanitizeWeekWorkoutChanges([], allowed).changes).toHaveLength(0);
    expect(sanitizeWeekWorkoutChanges(null, allowed).changes).toHaveLength(0);
  });
});
