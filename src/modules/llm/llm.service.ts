import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AthleteTrainingContextDto,
  EligibilityResultDto,
  ExtractedGoalDto,
  ExtractedRuleDto,
  LlmCoachReplyInput,
  LlmCoachReplyOutput,
  ReformulateGoalResultDto,
  TargetPacesDto,
} from "./dto/llm.dto";
import { validateCoachReplyOutput } from "./validation/coach-reply.validator";
import {
  buildDailyTssSeries,
  clampWeeklyVolumeRamp,
  computePacesFromRecentPerformance,
  computeReadinessScore,
  computeSessionTss,
  extractSessionMetricsFromWorkouts,
  generatePeriodizedMultiWeekFallback,
  getEasySinglePace,
  getLockedDayNamesFromRules,
  normalizeGeneratedWorkout,
  replayBanisterDaily,
  updateBanisterLoad,
} from "../../training-science";

@Injectable()
export class LlmService implements OnModuleInit {
  private readonly logger = new Logger(LlmService.name);
  private baseUrl: string;
  private apiKey: string;
  private lightModel: string;
  private proModel: string;
  private isOmniRouteLocal: boolean = false;

  constructor(private readonly configService: ConfigService) {
    this.baseUrl =
      this.configService.get<string>("LLM_BASE_URL") ||
      "https://generativelanguage.googleapis.com/v1beta/openai";

    this.apiKey =
      this.configService.get<string>("LLM_API_KEY") ||
      this.configService.get<string>("GEMINI_API_KEY") ||
      this.configService.get<string>("OMNIROUTE_API_KEY") ||
      "";

    this.lightModel =
      this.configService.get<string>("LLM_LIGHT_MODEL") ||
      "gemini-3.5-flash-lite";

    this.proModel =
      this.configService.get<string>("LLM_PRO_MODEL") || "gemini-3.8-flash";

    this.isOmniRouteLocal =
      this.baseUrl.includes("localhost:20128") ||
      this.baseUrl.includes("127.0.0.1:20128");
  }

  onModuleInit() {
    if (this.apiKey || this.isOmniRouteLocal) {
      this.logger.log(
        `✅ LlmService initialisé (Endpoint: ${this.baseUrl} | Light: ${this.lightModel} | Pro: ${this.proModel})`,
      );
    } else {
      this.logger.log(
        `ℹ️ LlmService initialisé en mode Hybride Déterministe (Ajoutez LLM_API_KEY ou lancez OmniRoute sur :20128 dans .env pour activer l'appel LLM externe).`,
      );
    }
  }

  // ============================================================================
  // 1. GARDE-FOUS MÉDICAUX & ÉLIGIBILITÉ CONTEXTUELLE (DÉTERMINISTE - 0 ms)
  // ============================================================================

  /**
   * Détecte les signaux d'urgence médicale ou de blessure aiguë (CDC Section 8)
   */
  public checkMedicalRedFlags(text: string): {
    isRedFlag: boolean;
    reason?: string;
    emergencyReply?: string;
  } {
    const lower = text.toLowerCase();

    // Signaux cardiovasculaires / neurologiques critiques
    const cardiacOrNeuroRegex =
      /(douleur\s+thoracique|oppression|poitrine|cœur\s+qui\s+s'emballe|vertige|malaise|évanoui|tête\s+qui\s+tourne|essoufflement\s+anormal)/i;
    if (cardiacOrNeuroRegex.test(lower)) {
      return {
        isRedFlag: true,
        reason: "cardiac_or_neuro_symptom",
        emergencyReply:
          "⚠️ Priorité absolue à ta santé : les symptômes que tu décris (oppression, vertiges ou malaise) imposent l'arrêt immédiat de tout effort physique. J'ai suspendu ta séance du jour. Consulte un médecin rapidement avant toute reprise.",
      };
    }

    // Blessures musculaires ou articulaires vives
    const acuteInjuryRegex =
      /(claquage|déchirure|coup\s+de\s+poignard|douleur\s+aiguë|impossible\s+de\s+poser\s+le\s+pied|entorse|blocage\s+au\s+genou)/i;
    if (acuteInjuryRegex.test(lower)) {
      return {
        isRedFlag: true,
        reason: "acute_musculoskeletal_injury",
        emergencyReply:
          "⚠️ Stop immédiat : face à une douleur vive ou suspicion de lésion musculaire/articulaire, courir aggraverait la blessure. Je bascule ton plan en repos complet et soins sans impact. Prends l'avis d'un médecin ou kiné du sport.",
      };
    }

    return { isRedFlag: false };
  }

  /**
   * Matrice d'éligibilité physiologique CONTEXTUELLE (Annexe CDC Section 2)
   * Ne bloque JAMAIS sans raison :
   * - Si la personne est déjà en milieu de prépa ou a le volume requis (ou le mentionne), l'objectif est 100 % accepté.
   * - Si l'historique Strava/Garmin n'est pas encore synchronisé, l'objectif est accepté (calibration dès synchro).
   * - Le refus pédagogique ne se déclenche QUE si le contexte réel prouve un écart dangereux entre le volume actuel et la cible.
   */
  public evaluateGoalEligibility(
    goalText: string,
    trainingContext?: AthleteTrainingContextDto,
  ): EligibilityResultDto {
    const lower = goalText.toLowerCase();

    // Extraction de la distance cible en km
    let distanceKm = 21.1;
    const explicitKmMatch = lower.match(/(\d{2,3})\s*km/i);
    if (explicitKmMatch) {
      distanceKm = parseInt(explicitKmMatch[1], 10);
    } else if (lower.includes("ultra")) {
      distanceKm = 100;
    } else if (
      lower.includes("marathon") &&
      !lower.includes("semi") &&
      !lower.includes("demi")
    ) {
      distanceKm = 42.2;
    } else if (lower.includes("semi") || lower.includes("21")) {
      distanceKm = 21.1;
    } else if (lower.includes("10")) {
      distanceKm = 10;
    } else if (lower.includes("5")) {
      distanceKm = 5;
    }

    // Extraction du délai souhaité (en semaines)
    let weeksAvailable = 12;
    const monthsMatch = lower.match(/(\d+)\s*mois/i);
    const weeksMatch = lower.match(/(\d+)\s*semaine/i);
    if (weeksMatch) {
      weeksAvailable = parseInt(weeksMatch[1], 10);
    } else if (monthsMatch) {
      weeksAvailable = parseInt(monthsMatch[1], 10) * 4;
    }

    // Détection si l'utilisateur précise lui-même dans son message qu'il est déjà entraîné / en cours de prépa
    const declaredVolumeMatch = lower.match(
      /(\d{2,3})\s*km\s*(par|\/)\s*semaine/i,
    );
    const isAlreadyInPrepInText =
      /(déjà\s+en\s+prépa|milieu\s+de\s+prépa|déjà\s+entraîné|je\s+cours\s+déjà|habitué\s+aux\s+ultras|bonne\s+base)/i.test(
        lower,
      );

    const effectiveWeeklyKm = declaredVolumeMatch
      ? parseInt(declaredVolumeMatch[1], 10)
      : trainingContext?.recentWeeklyKm;

    const longestRecentRunKm = trainingContext?.longestRecentRunKm ?? 0;
    const hasVerifiedContext =
      Boolean(trainingContext?.hasSyncedHistory) ||
      Boolean(declaredVolumeMatch) ||
      isAlreadyInPrepInText;

    // 1. Si l'utilisateur est déjà en milieu de préparation ou possède le volume adéquat -> ACCEPTÉ À 100 %
    if (
      isAlreadyInPrepInText ||
      (effectiveWeeklyKm !== undefined &&
        ((distanceKm >= 60 &&
          (effectiveWeeklyKm >= 50 || longestRecentRunKm >= 28)) ||
          (distanceKm >= 40 &&
            distanceKm < 60 &&
            (effectiveWeeklyKm >= 38 || longestRecentRunKm >= 22))))
    ) {
      return {
        status: "ELIGIBLE",
        isRealistic: true,
        pedagogicalMessage: `Tu disposes déjà de la charge d'entraînement adéquate (~${Math.round(effectiveWeeklyKm || 60)} km/sem) pour cet objectif. Je prends le relais sur ta préparation en cours !`,
      };
    }

    // 2. Si nous n'avons pas encore l'historique réel (ex: Onboarding avant synchro Strava/Garmin) -> AUCUN BLOCAGE ARBITRAIRE
    if (!hasVerifiedContext || effectiveWeeklyKm === undefined) {
      return {
        status:
          distanceKm >= 60 && weeksAvailable <= 12
            ? "CONTEXT_NEEDED"
            : "ELIGIBLE",
        isRealistic: true,
        pedagogicalMessage:
          distanceKm >= 60 && weeksAvailable <= 12
            ? `Objectif enregistré ! Dès que ton historique Strava/Garmin est synchronisé, je vérifierai ton volume actuel pour calibrer la suite de ta prépa.`
            : `Objectif enregistré et pris en compte pour calibrer ton plan sur ${weeksAvailable} semaines.`,
      };
    }

    // 3. Refus pédagogique UNIQUEMENT si le contexte prouve que l'utilisateur part de trop loin
    if (
      distanceKm >= 60 &&
      weeksAvailable <= 12 &&
      effectiveWeeklyKm < 35 &&
      longestRecentRunKm < 22
    ) {
      return {
        status: "UNREALISTIC_DANGEROUS",
        isRealistic: false,
        pedagogicalMessage: `Au vu de ton volume récent synchronisé (~${Math.round(effectiveWeeklyKm)} km/sem, sortie longue max ${Math.round(longestRecentRunKm || 12)} km), préparer un ${distanceKm} km en seulement ${weeksAvailable} semaines t'exposerait à un risque critique de blessure. Si tu as déjà un bloc d'entraînement non synchronisé, dis-le-moi pour que j'ajuste !`,
        suggestedAlternative: `Viser d'abord un format intermédiaire (35–50 km) dans ${weeksAvailable} semaines, ou étaler la prépa ${distanceKm} km sur 20–24 semaines.`,
      };
    }

    if (
      distanceKm >= 40 &&
      weeksAvailable <= 5 &&
      effectiveWeeklyKm < 25 &&
      longestRecentRunKm < 18
    ) {
      return {
        status: "UNREALISTIC_DANGEROUS",
        isRealistic: false,
        pedagogicalMessage: `Avec ton volume actuel (~${Math.round(effectiveWeeklyKm)} km/sem), un Marathon dans ${weeksAvailable} semaines est trop court pour assimiler la distance sans risque tendineux. Si tu es déjà en milieu de prépa hors-appli, précise-moi ton volume hebdo actuel !`,
        suggestedAlternative: `Préparation Marathon sur 12–16 semaines ou Semi-Marathon dans ${weeksAvailable} semaines.`,
      };
    }

    return {
      status: "ELIGIBLE",
      isRealistic: true,
      pedagogicalMessage: `Objectif cohérent avec ton profil d'entraînement (~${Math.round(effectiveWeeklyKm)} km/sem).`,
    };
  }

  // ============================================================================
  // 2. CALCULATEUR D'ALLURES PHYSIOLOGIQUES (BASÉ SUR SÉANCES RÉCENTES & FC)
  // ============================================================================

  /**
   * Calcule les allures d'entraînement UNIQUEMENT à partir des séances récentes
   * (allure observée + fréquence cardiaque associée) ou des zones de montre synchronisées
   * (Garmin Lactate Threshold / Strava Activities & HR Zones).
   * Ne calcule JAMAIS les allures d'entraînement à partir du chrono rêvé de l'objectif !
   *
   * Implémentation pure déplacée dans src/training-science/ (RILES-035).
   */
  public computePacesFromRecentPerformance(
    trainingContext?: AthleteTrainingContextDto,
  ): TargetPacesDto {
    return computePacesFromRecentPerformance(trainingContext);
  }

  /**
   * Convertit les séances (Workouts Prisma) en métriques (allure sec/km + FC bpm)
   * Utilise EN PRIORITÉ les vraies données de la séance réalisée (actualPace, actualAvgHeartRate, actualMaxHeartRate, actualDistanceKm)
   * issues des webhooks Strava / Garmin / Apple Santé.
   *
   * Implémentation pure déplacée dans src/training-science/ (RILES-035).
   */
  public extractSessionMetricsFromWorkouts(
    workouts: Array<{
      actualPace?: string | null;
      actualAvgHeartRate?: number | null;
      actualMaxHeartRate?: number | null;
      actualDistanceKm?: number | null;
      targetPace?: string | null;
      targetZoneBpm?: string | null;
      distance?: string | null;
      isRestDay?: boolean;
      isCommute?: boolean;
      sportType?: string | null;
    }>,
  ): AthleteTrainingContextDto["recentSessions"] {
    return extractSessionMetricsFromWorkouts(workouts);
  }

  /**
   * Extrait de manière déterministe les règles de vie mentionnées dans un texte
   */
  public extractRulesDeterministically(text: string): ExtractedRuleDto[] {
    const lower = text.toLowerCase();
    const rules: ExtractedRuleDto[] = [];

    // 1. Détection de jours bloqués / indisponibles
    const days = [
      "lundi",
      "mardi",
      "mercredi",
      "jeudi",
      "vendredi",
      "samedi",
      "dimanche",
    ];
    const blockedDays = days.filter((d) => {
      const regex = new RegExp(
        `(pas.*${d}|jamais.*${d}|indisponible.*${d}|sauf.*${d}|bloqué.*${d}|${d}.*impossible|${d}.*repos|${d}.*enfants|${d}.*famille)`,
        "i",
      );
      return regex.test(lower);
    });

    if (blockedDays.length > 0) {
      const formattedDays = blockedDays
        .map((d) => d.charAt(0).toUpperCase() + d.slice(1))
        .join(", ");
      rules.push({
        title: "Jours sanctuarisés",
        description: `Aucune séance programmée le ${formattedDays.toLowerCase()}.`,
        icon: "calendar-lock",
      });
    }

    // 2. Détection de sensibilité / prévention blessure
    if (
      lower.includes("mollet") ||
      lower.includes("genou") ||
      lower.includes("tendon") ||
      lower.includes("cheville") ||
      lower.includes("périostite") ||
      lower.includes("sans me blesser") ||
      lower.includes("blessure")
    ) {
      const zone = lower.includes("mollet")
        ? "des mollets"
        : lower.includes("genou")
          ? "des genoux"
          : lower.includes("tendon")
            ? "du tendon d'Achille"
            : "articulaire et musculaire";
      rules.push({
        title: "Prévention & Progressivité",
        description: `Protection prioritaire ${zone} (augmentation max +10 %/semaine).`,
        icon: "bullseye-arrow",
      });
    }

    // 3. Détection de nombre de séances par semaine ou durée max
    const freqMatch = lower.match(
      /(\d)\s*(séances?|fois)\s*(par|\/)\s*semaine/i,
    );
    if (freqMatch) {
      rules.push({
        title: "Fréquence hebdomadaire",
        description: `Maximum ${freqMatch[1]} séances par semaine pour respecter ton équilibre.`,
        icon: "clock-outline",
      });
    }

    return rules;
  }

  // ============================================================================
  // 3. IA DE REFORMULATION AUTOMATIQUE D'OBJECTIF (SANS BOUTON MANUEL)
  // ============================================================================

  async reformulateOnboardingGoal(
    rawGoal: string,
    trainingContext?: AthleteTrainingContextDto,
  ): Promise<ReformulateGoalResultDto> {
    const eligibility = this.evaluateGoalEligibility(rawGoal, trainingContext);
    const targetPaces = this.computePacesFromRecentPerformance(trainingContext);
    const deterministicRules = this.extractRulesDeterministically(rawGoal);
    const fallbackGoal = this.buildFallbackGoalExtraction(rawGoal);

    // Si LLM externe configuré, on enrichit automatiquement la reformulation et l'extraction via LLM_LIGHT_MODEL
    if (this.canCallExternalLlm()) {
      try {
        const systemPrompt = `Tu es le Coach IA de l'application Riles (coaching course à pied adaptatif et bienveillant).
Ta mission est de reformuler automatiquement le message de l'utilisateur en 1 phrase claire et motivante, et d'extraire les paramètres structurés en JSON strict.
IMPORTANT : Ne calcule JAMAIS les allures d'entraînement à partir de l'objectif. Utilise uniquement les allures physiologiques actuelles de l'athlète issues de ses séances récentes et de sa fréquence cardiaque : Endurance Z2=${targetPaces.easyPaceZ2}, Seuil Z4=${targetPaces.thresholdPaceZ4}.

Réponds UNIQUEMENT avec un objet JSON valide au format suivant :
{
  "reformulatedGoal": "string (1 phrase claire résumant l'objectif compris par le coach)",
  "extractedGoal": {
    "title": "string (ex: Semi-marathon de Paris)",
    "target": "string (ex: Passer sous 1h45)",
    "raceDate": "string (ex: Dans 16 semaines ou date mentionnée)",
    "weeksRemaining": number (16 si non précisé par l'utilisateur, ou nombre de semaines exact jusqu'à la date d'épreuve)
  },
  "extractedRules": [
    { "title": "string", "description": "string", "icon": "calendar-lock | clock-outline | bullseye-arrow | sleep" }
  ]
}`;

        const llmJson = await this.callOpenAiCompatibleJson<{
          reformulatedGoal?: string;
          extractedGoal?: ExtractedGoalDto;
          extractedRules?: ExtractedRuleDto[];
        }>(
          this.lightModel,
          systemPrompt,
          `Objectif utilisateur : "${rawGoal}"`,
        );

        if (llmJson && llmJson.reformulatedGoal) {
          return {
            reformulatedGoal: llmJson.reformulatedGoal,
            extractedGoal: {
              ...fallbackGoal,
              ...(llmJson.extractedGoal || {}),
            },
            extractedRules:
              llmJson.extractedRules && llmJson.extractedRules.length > 0
                ? llmJson.extractedRules
                : deterministicRules,
            targetPaces,
            eligibility,
          };
        }
      } catch (err: any) {
        this.logger.warn(
          `Fallback déterministe utilisé pour reformulateOnboardingGoal (${err?.message})`,
        );
      }
    }

    const reformulatedGoal = `Préparer « ${fallbackGoal.title} — ${fallbackGoal.target} » sur ${fallbackGoal.weeksRemaining} semaines (allures calibrées sur tes séances récentes & FC : Z2 ${targetPaces.easyPaceZ2}, Seuil ${targetPaces.thresholdPaceZ4}).`;

    return {
      reformulatedGoal,
      extractedGoal: fallbackGoal,
      extractedRules: deterministicRules,
      targetPaces,
      eligibility,
    };
  }

  // ============================================================================
  // 4. COACH CONVERSATIONNEL UNIFIÉ (ADAPTATION SÉANCE + RÈGLES DE VIE + GARDE-FOUS)
  // ============================================================================

  async generateCoachReply(
    input: LlmCoachReplyInput,
  ): Promise<LlmCoachReplyOutput> {
    const { userPrompt, athleteContext, conversationHistory } = input;

    // 1. Garde-fou déterministe #1 : Urgence médicale (0 ms)
    const medicalCheck = this.checkMedicalRedFlags(userPrompt);
    if (medicalCheck.isRedFlag && medicalCheck.emergencyReply) {
      return {
        replyText: medicalCheck.emergencyReply,
        reformulatedIntent: "Alerte médicale / Blessure vive détectée",
        safetyStatus: "medical_stop",
        suggestedAction: {
          type: "reduce_intensity",
          label: "Appliquer : Repos complet & Sécurité médicale",
          applied: false,
          details: "injury_care",
        },
        modelUsed: "deterministic-medical-guard",
      };
    }

    // 2. Garde-fou déterministe #2 : Éligibilité d'objectif UNIQUEMENT basée sur le contexte réel d'entraînement
    const lowerPrompt = userPrompt.toLowerCase();
    if (
      lowerPrompt.includes("ultra") ||
      lowerPrompt.includes("180 km") ||
      lowerPrompt.includes("100 km") ||
      lowerPrompt.includes("marathon")
    ) {
      const eligibility = this.evaluateGoalEligibility(
        userPrompt,
        athleteContext.trainingContext,
      );
      if (!eligibility.isRealistic) {
        return {
          replyText: `🛑 ${eligibility.pedagogicalMessage}\n\n💡 Ce que je te propose : ${eligibility.suggestedAlternative}`,
          reformulatedIntent:
            "Alerte pédagogique : écart important entre le volume actuel et l'objectif",
          safetyStatus: "unrealistic_goal",
          modelUsed: "deterministic-eligibility-guard",
        };
      }
    }

    // 3. Calcul des allures physiologiques à partir des séances récentes & FC (JAMAIS depuis l'objectif)
    const paces = this.computePacesFromRecentPerformance(
      athleteContext.trainingContext,
    );

    // 4. Appel LLM externe si configuré (OmniRoute / Gemini 3.5-3.8 Flash / OpenRouter)
    if (this.canCallExternalLlm()) {
      const isComplexPlanning =
        lowerPrompt.includes("plan") ||
        lowerPrompt.includes("semaine") ||
        lowerPrompt.includes("programme") ||
        lowerPrompt.includes("objectif");
      const selectedModel = isComplexPlanning ? this.proModel : this.lightModel;

      try {
        const systemPrompt = `Tu es Coach Riles IA, un coach de course à pied empathique, scientifique et non-culpabilisant.
RÈGLES STRICTES :
1. PRIORITÉ ABSOLUE À LA SÉANCE CIBLÉE (« 🎯 0. SÉANCE PRINCIPALE CIBLÉE PAR L'UTILISATEUR ») :
   - Lorsque cette section est présente, l'utilisateur a ouvert le chat depuis une journée précise du calendrier.
   - Dès qu'il dit « la séance », « cette séance », « celle-là », « qu'en penses-tu », « comment la courir », « à quoi elle sert », ou demande un ajustement sans préciser d'autre date, IL PARLE EXCLUSIVEMENT DE CETTE SÉANCE CIBLÉE (même si elle est située dans une autre semaine passée ou future). Ne réponds JAMAIS sur la séance d'aujourd'hui à la place si la date ciblée est différente !
   - S'il s'agit d'une séance future prévue : explique-lui comment l'aborder (allures cibles, zones cardio, déroulé des blocs d'effort) et son utilité physiologique dans sa semaine et sa prépa globale.
   - S'il s'agit d'une séance passée réalisée : analyse ses vraies métriques réalisées (distance, allure, fréquence cardiaque, dénivelé, charge TSS) en la replaçant dans son contexte de forme et d'objectif.
   - S'il s'agit d'un jour de repos : explique le rôle d'assimilation de cette journée dans sa semaine.
2. Reformule toujours brièvement l'intention de l'utilisateur dès le début de ta réponse ("reformulatedIntent" et première phrase de "replyText"), sans formules robotiques répétitives.
3. Zéro culpabilisation : valorise toujours l'écoute du corps et le repos quand il est plus rentable qu'une séance forcée.
4. RÈGLES DE VIE (LIFE RULES) :
   - N'ajoute JAMAIS de règle de vie (type="add_life_rule") pour une simple question, une discussion d'entraînement, ou une adaptation ponctuelle de séance (fatigue du jour, manque de temps, séance allégée ou décalée) !
   - Vérifie toujours la liste athleteContext.rules : si une règle similaire existe déjà, ne la recrée pas !
   - N'ajoute une règle (type="add_life_rule") QUE si l'utilisateur demande explicitement d'instaurer une contrainte permanente dans son emploi du temps (ex: « Bloque définitivement mes jeudis », « Je ne peux plus jamais courir le samedi »).
5. Si l'utilisateur signale un problème ponctuel, un imprévu, une fatigue, un manque de temps ou une gêne musculaire, recalcule dynamiquement la séance ciblée ET rééquilibre les séances restantes de cette semaine ("recalculatedWeekWorkouts") en respectant ses règles de vie (jours bloqués) et choisis parmi ces details autorisés :
   - "lighten" (raccourcir/alléger à 35 min Zone 2 et lisser la semaine)
   - "easy_run" (remplacer par 30 min footing régénérant Zone 1-2)
   - "postpone" (décaler la séance et réorganiser les jours suivants)
   - "injury_care" (20 min mobilité douce sans impact et assouplir la fin de semaine)
6. Ne calcule JAMAIS les allures à partir de l'objectif rêvé. Respecte strictement les allures physiologiques calculées sur les séances récentes et la fréquence cardiaque de l'athlète : Endurance Z2=${paces.easyPaceZ2}, Allure Marathon Z3=${paces.marathonPaceZ3}, Seuil Z4=${paces.thresholdPaceZ4}, VMA Z5=${paces.intervalPaceZ5}.
7. Pour tout objectif ambitieux (ex: Ultra, Marathon), juge sa faisabilité UNIQUEMENT par rapport au contexte d'entraînement réel de l'athlète (s'il est déjà en milieu de prépa avec le bon volume, valide-le à 100 %).
8. AJUSTEMENT DU VOLUME KILOMÉTRIQUE OU DU PLAN :
   - Si l'utilisateur demande d'ajuster le volume (ex: « plus de km », « moins de kilomètres », « augmenter le volume », « trop court », « trop long », « adapter une phase ») :
   - Agis en coach sage et expérimenté : explique les compromis physiologiques (ex: progression plafonnée à +10-15% par semaine max pour préserver les tendons et articulations).
   - Si la demande est pertinente, adapte les distances et durées des séances de la semaine dans "recalculatedWeekWorkouts" (en priorité sur l'Endurance Fondamentale Z2 et la Sortie Longue).
9. PROPOSITIONS, JAMAIS D'APPLICATIONS IMAGINÉES :
   - Toute modification du plan (recalculatedWeekWorkouts ou add_life_rule) est une PROPOSITION qui ne sera appliquée qu'après confirmation explicite de l'utilisateur dans l'app.
   - Formule donc tes suggestions au conditionnel (« je te propose d'alléger… », « veux-tu que je passe… ? ») et ne présente JAMAIS une modification comme déjà effectuée (évite « J'ai allégé », « c'est fait », « j'ai inséré »).
   - Si le contexte contient « HISTORIQUE RÉCENT DE LA CONVERSATION », utilise-le pour répondre aux références implicites (« comme je te disais », « l'autre jour ») sans te contredire.

CONTEXTE ATHLÈTE CONDENSÉ & ANONYMISÉ :
${this.buildCompactAthleteMarkdownContext(athleteContext, paces)}
${this.buildConversationHistorySection(conversationHistory)}

Réponds UNIQUEMENT avec un objet JSON valide :
{
  "replyText": "string (ta réponse bienveillante en français, 2 à 4 phrases max, centrée en priorité sur la séance ciblée tout en tenant compte du profil global de l'athlète)",
  "reformulatedIntent": "string (résumé court de la demande)",
  "safetyStatus": "safe | warning_fatigue | medical_stop | unrealistic_goal",
  "suggestedAction": {
    "type": "adjust_workout | reschedule | reduce_intensity | add_life_rule | recalculate_week",
    "label": "string (ex: Proposition : séance allégée & fin de semaine ajustée)",
    "applied": false,
    "details": "lighten | easy_run | postpone | injury_care | add_life_rule | increase_volume | decrease_volume",
    "ruleData": { "title": "string", "description": "string", "icon": "calendar-lock | clock-outline | bullseye-arrow | sleep" }
  },
  "recalculatedWeekWorkouts": [
    {
      "dateKey": "YYYY-MM-DD",
      "isRestDay": boolean,
      "category": "ENDURANCE FONDAMENTALE | SÉANCE QUALITATIVE | SORTIE LONGUE | RENFORCEMENT & MOBILITÉ | RÉCUPÉRATION PASSIVE",
      "title": "string",
      "duration": "string",
      "distance": "string",
      "targetPace": "string",
      "targetZoneLabel": "string",
      "targetZoneBpm": "string",
      "aiAdjustmentNote": "string",
      "tags": ["string"]
    }
  ]
}
(Note: mets suggestedAction et recalculatedWeekWorkouts à null si aucune modification du planning n'est nécessaire).`;

        const parsed = await this.callOpenAiCompatibleJson<unknown>(
          selectedModel,
          systemPrompt,
          userPrompt,
        );

        // RILES-011 — Toute sortie de modèle est validée contre un schéma
        // strict AVANT d'être retournée au coach : JSON malformé, champ
        // inconnu, type d'action ou dateKey hors schéma => rejet complet et
        // repli sur le moteur hybride local (aucune donnée du modèle non
        // validée n'atteint la base).
        if (parsed !== null && parsed !== undefined) {
          const validation = validateCoachReplyOutput(parsed);
          if (validation.ok && validation.value) {
            const coachReply = validation.value;
            const action = coachReply.suggestedAction;
            return {
              replyText: coachReply.replyText,
              reformulatedIntent: coachReply.reformulatedIntent,
              safetyStatus: coachReply.safetyStatus || "safe",
              suggestedAction: action
                ? { ...action, details: action.details || "" }
                : undefined,
              recalculatedWeekWorkouts: coachReply.recalculatedWeekWorkouts,
              modelUsed: selectedModel,
            };
          }
          this.logger.warn(
            `Sortie du modèle rejetée (RILES-011) — repli sur le moteur hybride local : ${validation.errors.join(" | ")}`,
          );
        }
      } catch (err: any) {
        this.logger.warn(
          `Fallback moteur hybride local pour generateCoachReply (${err?.message})`,
        );
      }
    }

    // 5. Moteur Hybride Local Intelligent (0 ms, fonctionne même hors-ligne / sans clé)
    return this.generateDeterministicCoachReply(
      userPrompt,
      athleteContext,
      paces,
    );
  }

  /**
   * Construit une fiche athlète condensée en Markdown :
   * - 0. Séance principale ciblée par l'utilisateur (et la semaine de cette séance)
   * - 1. Profil athlète & forme Banister (100 % anonyme)
   * - 2. Allures physiologiques calculées
   * - 3. Règles de vie
   * - 4. Historique récent (-7 jours autour d'aujourd'hui) & 5. Plan immédiat (+7 jours)
   *
   * RILES-029 : aucune valeur par défaut n'est inventée — une donnée absente
   * est explicitement déclarée « non renseignée » dans le prompt.
   */
  /**
   * RILES-028 — Fenêtre bornée (12 messages max, 400 car./message) de
   * l'historique récent, re-soumise au LLM pour que le coach ne perde pas le
   * fil de la conversation en cours de session.
   */
  public buildConversationHistorySection(
    conversationHistory?: LlmCoachReplyInput["conversationHistory"],
  ): string {
    if (!conversationHistory || conversationHistory.length === 0) {
      return "";
    }
    const lines = conversationHistory.slice(-12).map((turn) => {
      const text =
        turn.text.length > 400 ? `${turn.text.slice(0, 400)}…` : turn.text;
      return `- ${turn.role === "user" ? "Utilisateur" : "Coach"} : ${text}`;
    });
    return `HISTORIQUE RÉCENT DE LA CONVERSATION (contexte du fil — réponds en cohérence avec ces échanges) :\n${lines.join("\n")}`;
  }

  public buildCompactAthleteMarkdownContext(
    athleteContext: LlmCoachReplyInput["athleteContext"],
    paces: TargetPacesDto,
  ): string {
    const today =
      athleteContext.todayDate || new Date().toISOString().split("T")[0];
    // RILES-029 — Aucune valeur par défaut fabriquée : une donnée absente est
    // déclarée « non renseignée » plutôt qu'estimée, pour que le modèle ne
    // reçoive jamais un fait utilisateur qu'il ne peut pas tracer en base.
    const weeksRemaining = athleteContext.activeGoalWeeksRemaining;
    const rawWeeklyKm =
      athleteContext.trainingContext?.recentWeeklyKm ||
      athleteContext.trainingContext?.recent4WeeksAvgKm ||
      (athleteContext.totalKm && athleteContext.activeWeeks
        ? athleteContext.totalKm / Math.max(1, athleteContext.activeWeeks)
        : undefined);
    const weeklyKm =
      rawWeeklyKm !== undefined && Number.isFinite(rawWeeklyKm)
        ? Math.round(rawWeeklyKm)
        : undefined;
    const banisterMeasured =
      Boolean(athleteContext.tsbForm) ||
      Boolean(athleteContext.atlFatigue) ||
      Boolean(athleteContext.ctlFitness);

    // 0. Séance principale ciblée par l'utilisateur (Priorité n°1)
    let targetedWorkoutSection = "";
    if (athleteContext.activeWorkout) {
      const act = athleteContext.activeWorkout;
      const actDate = act.dateKey || today;
      const temporalLabel =
        actDate === today
          ? `AUJOURD'HUI (${actDate})`
          : actDate < today
            ? `SÉANCE PASSÉE DU ${act.fullDateLabel || actDate} (${actDate})`
            : `SÉANCE FUTURE PRÉVUE LE ${act.fullDateLabel || actDate} (${actDate})`;

      const isDone =
        act.status === "DONE" ||
        act.status === "done" ||
        (act.actualDistanceKm !== undefined && act.actualDistanceKm !== null);

      const detailsLines: string[] = [
        `- Date ciblée : ${temporalLabel}${act.weekNumber ? ` • Semaine ${act.weekNumber}` : ""}`,
        `- Séance : ${act.title || "Séance"}${act.category ? ` [${act.category}]` : ""}${act.sportType ? ` (Sport : ${act.sportType})` : ""}`,
      ];

      if (act.isRestDay) {
        detailsLines.push(`- Statut : JOUR DE REPOS & ASSIMILATION`);
        if (act.aiAdjustmentNote) {
          detailsLines.push(`- Note coach : ${act.aiAdjustmentNote}`);
        }
      } else if (isDone) {
        detailsLines.push(`- Statut : SÉANCE RÉALISÉE`);
        const distStr =
          act.actualDistanceKm !== undefined && act.actualDistanceKm !== null
            ? `${act.actualDistanceKm} km`
            : act.distance || "—";
        const durStr = act.actualDurationSec
          ? `${Math.floor(act.actualDurationSec / 60)} min`
          : act.duration || "—";
        const paceStr = act.actualPace || act.targetPace || "—";
        detailsLines.push(
          `- Métriques réalisées : Distance ${distStr} | Durée ${durStr} | Allure moyenne ${paceStr}`,
        );
        if (act.actualAvgHeartRate || act.actualMaxHeartRate) {
          detailsLines.push(
            `- Cardio mesuré : FC moyenne ${act.actualAvgHeartRate || "—"} bpm${act.actualMaxHeartRate ? ` (FC max ${act.actualMaxHeartRate} bpm)` : ""}`,
          );
        }
        if (act.actualElevationGain || act.actualCadence || act.tss) {
          detailsLines.push(
            `- Données complémentaires : ${act.actualElevationGain ? `D+ ${act.actualElevationGain} m | ` : ""}${act.actualCadence ? `Cadence ${act.actualCadence} spm | ` : ""}${act.tss ? `Charge TSS ${act.tss}` : ""}`,
          );
        }
      } else {
        detailsLines.push(`- Statut : SÉANCE PLANIFIÉE AU PROGRAMME`);
        detailsLines.push(
          `- Objectifs de la séance : Distance prévue ${act.distance || "—"} | Durée prévue ${act.duration || "—"} | Allure cible ${act.targetPace || paces.easyPaceZ2} | Zone cardio ${act.targetZoneLabel || "Zone 2"}${act.targetZoneBpm ? ` (${act.targetZoneBpm})` : ""}${act.tss ? ` | Charge TSS prévue ${act.tss}` : ""}`,
        );
        if (Array.isArray(act.effortBlocks) && act.effortBlocks.length > 0) {
          const blocksStr = act.effortBlocks
            .map((b) => `${b.title} (${b.durationLabel})`)
            .join(" → ");
          detailsLines.push(`- Structure / Blocs de la séance : ${blocksStr}`);
        }
        if (act.aiAdjustmentNote) {
          detailsLines.push(
            `- Intention pédagogique : ${act.aiAdjustmentNote}`,
          );
        }
      }

      if (
        athleteContext.currentWeekWorkouts &&
        athleteContext.currentWeekWorkouts.length > 0
      ) {
        const weekLines = athleteContext.currentWeekWorkouts.map((w) => {
          const marker = w.dateKey === actDate ? "👉 [CIBLÉE] " : "";
          if (w.isRestDay) {
            return `  • ${marker}${w.dayName} ${w.dateKey} : Repos (${w.title})`;
          }
          const doneInfo =
            w.actualDistanceKm != null
              ? `Réalisé : ${w.actualDistanceKm} km à ${w.actualPace || "—"}${w.actualAvgHeartRate ? ` (${w.actualAvgHeartRate} bpm)` : ""}`
              : `Prévu : ${w.distance} (${w.duration}) • Cible ${w.targetPace || paces.easyPaceZ2}`;
          return `  • ${marker}${w.dayName} ${w.dateKey} : ${w.title} [${doneInfo}]`;
        });
        detailsLines.push(
          `- Semaine complète entourant cette séance ciblée :\n${weekLines.join("\n")}`,
        );
      }

      targetedWorkoutSection = `### 🎯 0. SÉANCE PRINCIPALE CIBLÉE PAR L'UTILISATEUR (OBJET PRIORITAIRE DU MESSAGE)\n${detailsLines.join("\n")}\n\n`;
    }

    // 1. Profil & Forme Banister (Anonymisé)
    const profileSection = `### 1. PROFIL ATHLÈTE (Anonyme)
- Date du jour (aujourd'hui) : ${today}
- Objectif : ${athleteContext.activeGoalTitle || "Objectif Course"} (${athleteContext.activeGoalTarget || "Terminer en forme"})
- Calendrier : ${
      weeksRemaining
        ? `Préparation en cours (reste ~${weeksRemaining} semaines)`
        : "Durée de préparation non renseignée (ne jamais inventer de reste-semaines)"
    }
- Échéance : ${athleteContext.activeGoalRaceDate || "Non définie"}
- Volume habituel : ${
      weeklyKm !== undefined
        ? `~${weeklyKm} km/semaine`
        : "Non déterminé (aucune donnée de volume — ne jamais estimer)"
    }
- Forme actuelle (Banister) : ${
      banisterMeasured
        ? `TSB (Forme) ${athleteContext.tsbForm ?? 0} | ATL (Fatigue) ${athleteContext.atlFatigue ?? 0} | CTL (Fitness) ${athleteContext.ctlFitness ?? 0}`
        : "Non mesurée (aucune séance synchronisée — ne jamais avancer de valeurs TSB/ATL/CTL)"
    }`;

    // 2. Allures physiologiques
    const pacesSection = `### 2. ALLURES PHYSIOLOGIQUES OBSERVÉES (Calibrées sur sorties réelles & FC)
- Zone 2 (Endurance fondamentale) : ${paces.easyPaceZ2}
- Zone 3 (Tempo / Allure spécifique) : ${paces.marathonPaceZ3}
- Zone 4 (Seuil anaérobie) : ${paces.thresholdPaceZ4}
- Zone 5 (VMA / Intervalles) : ${paces.intervalPaceZ5}
- Allure cible course : ${paces.targetRacePace}`;

    // 3. Règles de vie
    const rulesList =
      athleteContext.rules && athleteContext.rules.length > 0
        ? athleteContext.rules
            .map((r) => `- ${r.title} : ${r.description}`)
            .join("\n")
        : "- Aucune contrainte spécifique enregistrée.";
    const rulesSection = `### 3. RÈGLES DE VIE (À respecter scrupuleusement)\n${rulesList}`;

    // RILES-029 — La section « macrocycle » (4 phases de 12 semaines) a été
    // supprimée : l'application ne stocke aucun macrocycle, la présenter comme
    // le plan de l'athlète était une donnée fabriquée. Le modèle s'appuie
    // uniquement sur des faits traçables en base.

    // 4. Historique récent (-7 jours autour d'aujourd'hui)
    const pastItems: string[] = [];
    for (const w of athleteContext.pastCompletedWorkouts || []) {
      const dist = w.actualDistanceKm
        ? `${w.actualDistanceKm} km`
        : w.distance || "";
      const pace = w.actualPace ? `• Allure ${w.actualPace}` : "";
      const hr = w.actualAvgHeartRate ? `• FC ${w.actualAvgHeartRate} bpm` : "";
      pastItems.push(
        `- ${w.dateKey} : ${w.title} (${dist} ${pace} ${hr}) [Fait]`,
      );
    }
    const pastSection = `### 4. HISTORIQUE RÉCENT DE L'ATHLÈTE (-7 JOURS)\n${
      pastItems.length > 0
        ? pastItems.join("\n")
        : "- Aucune sortie enregistrée sur les 7 derniers jours."
    }`;

    // 6. Plan immédiat (+7 jours autour d'aujourd'hui)
    const upcomingItems: string[] = [];
    for (const w of athleteContext.upcomingPlannedWorkouts || []) {
      const rest = w.isRestDay
        ? `REPOS (${w.title})`
        : `${w.title} (${w.distance} • Cible ${w.targetPace || paces.easyPaceZ2})`;
      upcomingItems.push(`- ${w.dayName || ""} ${w.dateKey} : ${rest} [Prévu]`);
    }
    const upcomingSection = `### 5. PLAN IMMÉDIAT AUTOUR D'AUJOURD'HUI (+7 JOURS)\n${
      upcomingItems.length > 0
        ? upcomingItems.join("\n")
        : "- Planning de la semaine en cours d'ajustement."
    }`;

    return `${targetedWorkoutSection}${profileSection}\n\n${pacesSection}\n\n${rulesSection}\n\n${pastSection}\n\n${upcomingSection}`;
  }

  // ============================================================================
  // 5. GÉNÉRATEUR DE PLAN MULTI-SEMAINES PAR LLM PRO (AVEC CONTEXTE COMPLET & LIFE RULES)
  // ============================================================================

  /**
   * Calcule le Training Stress Score (hrTSS / Banister TRIMP normalisé) d'une séance
   *
   * Implémentation pure déplacée dans src/training-science/ (RILES-035).
   */
  public computeSessionTss(
    durationSecOrObj:
      | number
      | {
          durationSec: number;
          distanceKm?: number;
          avgHeartRate?: number;
          maxHeartRate?: number;
          hrMax?: number;
          rpe?: number;
          srpe?: number;
        },
    avgHeartRateArg?: number,
    hrMaxArg = 190,
  ): number {
    return computeSessionTss(durationSecOrObj, avgHeartRateArg, hrMaxArg);
  }

  /**
   * Met à jour les charges physiologiques de Banister :
   * - ATL (Fatigue aiguë 7 jours)
   * - CTL (Condition chronique 42 jours)
   * - TSB (Forme = CTL - ATL)
   * - ReadinessScore (0-100)
   *
   * Implémentation pure déplacée dans src/training-science/ (RILES-035).
   */
  public updateBanisterLoad(
    currentAtlOrObj:
      | number
      | {
          previousAtl: number;
          previousCtl: number;
          todayTss: number;
          sleepScore?: number;
          hrvStatus?: string;
        },
    currentCtlArg?: number,
    sessionTssArg?: number,
  ): {
    atlFatigue: number;
    ctlFitness: number;
    tsbForm: number;
    readinessScore: number;
  } {
    return updateBanisterLoad(currentAtlOrObj, currentCtlArg, sessionTssArg);
  }

  /**
   * Rejoue l'EWMA de Banister une fois par jour civil (RILES-020).
   *
   * Implémentation pure dans src/training-science/.
   */
  public replayBanisterDaily(
    days: number[],
    options: { sleepScore?: number; hrvStatus?: string } = {},
  ): { atlFatigue: number; ctlFitness: number; tsbForm: number; readinessScore: number; steps: number } {
    return replayBanisterDaily(days, options);
  }

  /**
   * Étale des charges TSS sur tous les jours civils d'une période (RILES-020).
   *
   * Implémentation pure dans src/training-science/.
   */
  public buildDailyTssSeries(
    entries: Array<{ dateKey: string; tss: number }>,
  ): number[] {
    return buildDailyTssSeries(entries);
  }

  /**
   * Score de readiness pondérant TSB, sommeil et HRV (RILES-026).
   *
   * Implémentation pure dans src/training-science/.
   */
  public computeReadinessScore(
    tsbForm: number,
    sleepScore?: number,
    hrvStatus?: string,
  ): number {
    return computeReadinessScore(tsbForm, sleepScore, hrvStatus);
  }

  /**
   * Garde-fou +10 % de volume hebdomadaire (RILES-023).
   *
   * Implémentation pure dans src/training-science/.
   */
  public clampWeeklyVolumeRamp(
    proposedKm: number,
    referenceKm: number,
  ): { km: number; clamped: boolean } {
    return clampWeeklyVolumeRamp(proposedKm, referenceKm);
  }

  /**
   * Détecte les jours de la semaine verrouillés dans les LifeRules de l'utilisateur
   *
   * Implémentation pure déplacée dans src/training-science/ (RILES-035).
   */
  public getLockedDayNamesFromRules(
    lifeRules: Array<{ title: string; description: string }>,
  ): Set<string> {
    return getLockedDayNamesFromRules(lifeRules);
  }

  /**
   * Génère un plan d'entraînement multi-semaines complet via le meilleur modèle (LLM_PRO_MODEL)
   * en lui fournissant TOUT le contexte de l'athlète, ses 6 derniers mois de données Strava,
   * ses vraies allures (issues des séances récentes & FC) et ses LifeRules.
   */
  async generateMultiWeekPlan(input: any): Promise<{
    planSummary: string;
    modelUsed: string;
    workouts: any[];
  }> {
    const lockedDays = this.getLockedDayNamesFromRules(input.lifeRules || []);
    const paces = input.calculatedPaces;
    const strava6m = input.sixMonthsStravaSummary;

    if (this.canCallExternalLlm()) {
      try {
        const systemPrompt = `Tu es le Directeur de la Performance et Coach IA de Riles.
Ta mission est de générer un plan d'entraînement multi-semaines COMPLET, individualisé et périodisé pour l'athlète, directement insérable dans notre base de données PostgreSQL.

RÈGLES ABSOLUES DE CONSTRUCTION DU PLAN :
1. RESPECT STRICT DES RÈGLES DE VIE (LIFE RULES) :
   - Jours bloqués par l'athlète : ${Array.from(lockedDays).join(", ") || "Aucun jour fixe bloqué"}.
   - Sur chaque jour bloqué par une LifeRule de l'athlète, tu DOIS impérativement mettre "isRestDay": true, "category": "RÉCUPÉRATION PASSIVE", "title": "Jour de repos (Contrainte respectée)", "duration": "—", "distance": "0 km".
   - ATTENTION ABSOLUE : Si AUCUN jour n'est bloqué par une LifeRule de l'athlète, NE BLOQUE AUCUN JOUR ARBITRAIREMENT ! Chaque coureur a un planning personnel différent. Ne présume jamais que le jeudi ou les week-ends sont des jours de repos obligatoires. Répartis 3 à 4 séances par semaine de manière équilibrée et personnalisée (ex: Mardi qualité/seuil, Jeudi endurance/spécifique, Samedi ou Dimanche sortie longue), en alternant intelligemment travail et récupération.
2. RESPECT DES ALLURES PHYSIOLOGIQUES RÉELLES (ISSUES DES 6 DERNIERS MOIS STRAVA & FC) :
   - Endurance fondamentale (Zone 2) : ${paces.easyPaceZ2} (132–148 bpm)
   - Allure Marathon / Tempo (Zone 3) : ${paces.marathonPaceZ3} (150–160 bpm)
   - Allure Seuil Anaérobie (Zone 4) : ${paces.thresholdPaceZ4} (162–174 bpm)
   - Allure VMA / Intervalle (Zone 5) : ${paces.intervalPaceZ5} (176–188 bpm)
3. RÈGLES SCIENTIFIQUES DE CHARGE & PROGRESSIVITÉ DYNAMIQUE DU PLAN :
   - Bilan 6 mois Strava : ${strava6m ? `${strava6m.totalActivities} séances, ${strava6m.totalDistanceKm} km cumulés, moyenne 4 dernières semaines = ${strava6m.recent4WeeksAvgKm} km/sem, plus longue sortie = ${strava6m.longestRunKm} km` : `Volume hebdo récent = ${input.physiologicalState?.recentWeeklyKm || 30} km/sem`}.
   - DÉMARRAGE ADAPTÉ & TRANQUILLE (SEMAINE 1) : Ne jamais démarrer brutalement à un volume écrasant. Calibre la Semaine 1 à environ 80-85% du volume récent réel de l'athlète (ex: s'il a l'habitude de courir 25 km/semaine, démarre la semaine 1 autour de 20-24 km ; on ne passe jamais de 0 à 30+ km d'entrée de jeu).
   - RÈGLE DES 10 % PAR SEMAINE (SURCHARGE PROGRESSIVE) : Chaque semaine de montée en charge, augmente le volume d'environ +8 % à +12 % (règle des ~10 %). La progression doit être dynamique et évolutive semaine après semaine. Ne stagne JAMAIS sur le même volume pendant 3 semaines !
   - CYCLES 3:1 (CHARGE & ASSIMILATION) :
     * 3 semaines de montée continue (+10 % par semaine)
     * 1 semaine d'assimilation (deload) avec une réduction de -20 % à -25 % du volume pour assimiler les adaptations physiologiques et surcompenser.
     * DÈS LA SEMAINE SUIVANTE (reprise de cycle), on repart à un palier PLUS ÉLEVÉ que le précédent cycle (+10 % par rapport à la S3 du cycle précédent). Il doit y avoir une vraie progression par paliers ascendants !
   - SORTIE LONGUE ÉVOLUTIVE : La sortie longue du week-end progresse en harmonie avec le volume hebdomadaire sans dépasser 35-38 % du volume de la semaine.
   - PIC SPÉCIFIQUE & AFFÛTAGE : Le volume culmine 3 à 4 semaines avant l'échéance (pic spécifique marathon), suivi d'une phase d'affûtage décroissante les 2 dernières semaines (-25 % puis -45 %) pour arriver avec une fraîcheur et une réserve glycogénique maximales le jour de la course.

CONTEXTE COMPLET DE L'ATHLÈTE (INCLUANT 6 MOIS DE DONNÉES STRAVA) :
${JSON.stringify({
  userProfile: input.userProfile,
  physiologicalState: input.physiologicalState,
  sixMonthsStravaSummary: input.sixMonthsStravaSummary,
  calculatedPaces: input.calculatedPaces,
  lifeRules: input.lifeRules,
  recentCompletedSessions: input.recentCompletedSessions,
})}

CRÉNEAUX CALENDAIRES EXACTS À REMPLIR (1 objet workout par créneau dateKey) :
${JSON.stringify(input.calendarSlots)}

Réponds UNIQUEMENT avec un objet JSON strictement valide au format suivant :
{
  "planSummary": "string (Présentation claire et motivante du plan généré sur plusieurs semaines, mentionnant explicitement comment ses 6 derniers mois Strava ont servi à calibrer ses allures et son volume, ainsi que le respect de ses règles de vie)",
  "workouts": [
    {
      "dateKey": "YYYY-MM-DD",
      "dayName": "Lun | Mar | Mer | Jeu | Ven | Sam | Dim",
      "dayNumber": number,
      "month": number,
      "year": number,
      "weekNumber": number,
      "fullDateLabel": "string",
      "timeLabel": "18:30 | 09:00 | Jour de repos",
      "isRestDay": boolean,
      "category": "ENDURANCE FONDAMENTALE | SÉANCE QUALITATIVE | SORTIE LONGUE | RENFORCEMENT & MOBILITÉ | RÉCUPÉRATION PASSIVE",
      "title": "string (titre précis de la séance)",
      "duration": "string (ex: 45 min, 1h15, —)",
      "distance": "string (ex: 8,0 km, 14,5 km, 0 km)",
      "targetPace": "string (ex: ${paces.easyPaceZ2} ou ${paces.thresholdPaceZ4} ou —)",
      "targetZoneLabel": "Zone 2 | Zone 3–4 | Zone 1",
      "targetZoneBpm": "135–148 bpm | 160–172 bpm | < 110 bpm",
      "pinPositionPercent": number,
      "effortBlocks": [
        { "title": "Échauffement", "durationLabel": "15 min", "type": "warmup", "flexRatio": 1 },
        { "title": "Corps de séance", "durationLabel": "30 min", "type": "threshold", "flexRatio": 2 },
        { "title": "Retour au calme", "durationLabel": "10 min", "type": "cooldown", "flexRatio": 1 }
      ],
      "tags": ["string", "string", "string"],
      "aiAdjustmentNote": "string (explication personnalisée du coach pour cette séance)",
      "tss": number
    }
  ]
}`;

        const llmPlan = await this.callOpenAiCompatibleJson<{
          planSummary?: string;
          workouts?: any[];
        }>(
          this.proModel,
          systemPrompt,
          `Génère le plan multi-semaines complet pour ${input.userProfile.name} (${input.calendarSlots.length} jours) à partir de ses 6 mois d'historique Strava.`,
          25000,
        );

        if (
          llmPlan &&
          Array.isArray(llmPlan.workouts) &&
          llmPlan.workouts.length > 0
        ) {
          const normalizedWorkouts = input.calendarSlots.map((slot: any) => {
            const found = llmPlan.workouts!.find(
              (w: any) => w.dateKey === slot.dateKey,
            );
            return normalizeGeneratedWorkout(slot, found, lockedDays, paces);
          });

          return {
            planSummary:
              llmPlan.planSummary ||
              `Plan multi-semaines généré par ${this.proModel} pour « ${input.userProfile.activeGoalTitle} » à partir de tes 6 derniers mois Strava (Z2 ${paces.easyPaceZ2}, Seuil ${paces.thresholdPaceZ4}).`,
            modelUsed: this.proModel,
            workouts: normalizedWorkouts,
          };
        }
      } catch (err: any) {
        this.logger.warn(
          `Fallback générateur multi-semaines structuré utilisé (${err?.message})`,
        );
      }
    }

    return generatePeriodizedMultiWeekFallback(
      input,
      lockedDays,
      paces,
      this.proModel,
    );
  }

  // normalizeGeneratedWorkout() et generatePeriodizedMultiWeekFallback() sont
  // extraits dans src/training-science/plan-generator.ts (RILES-035).

  // ============================================================================
  // 6. MOTEUR DE FALLBACK DÉTERMINISTE ENRICHI (RÈGLES DE VIE + RECALCUL SEMAINE)
  // ============================================================================

  private generateDeterministicCoachReply(
    userPrompt: string,
    athleteContext: LlmCoachReplyInput["athleteContext"],
    paces: TargetPacesDto,
  ): LlmCoachReplyOutput {
    const lowerText = userPrompt.toLowerCase();
    const easySinglePace = getEasySinglePace(paces);

    // Cas A : L'utilisateur demande à voir ou consulter ses règles de vie actuelles
    if (
      (lowerText.includes("mes règles") ||
        lowerText.includes("mes contraintes")) &&
      !lowerText.includes("ajout") &&
      !lowerText.includes("plus") &&
      !lowerText.includes("pas")
    ) {
      const currentRules = athleteContext.rules || [];
      const rulesList =
        currentRules.length > 0
          ? currentRules
              .map((r) => `• ${r.title} : ${r.description}`)
              .join("\n")
          : "Aucune règle spécifique enregistrée pour le moment.";
      return {
        replyText: `Voici tes règles de vie actuelles que je respecte pour construire ton plan :\n${rulesList}\n\nDis-moi simplement si tu veux en ajouter ou en modifier une !`,
        reformulatedIntent: "Consultation des règles de vie",
        safetyStatus: "safe",
        modelUsed: "hybrid-rule-engine",
      };
    }

    // Cas B : L'utilisateur exprime une nouvelle Règle de Vie / Contrainte durable dans le chat
    const extractedRules = this.extractRulesDeterministically(userPrompt);
    const isExplicitRuleIntent =
      lowerText.includes("règle") ||
      lowerText.includes("contrainte") ||
      lowerText.includes("jamais le") ||
      lowerText.includes("pas courir le") ||
      lowerText.includes("indisponible le") ||
      lowerText.includes("bloquer le") ||
      lowerText.includes("chaque semaine");

    if (extractedRules.length > 0 || isExplicitRuleIntent) {
      const newRule: ExtractedRuleDto = extractedRules[0] || {
        title: "Contrainte personnelle",
        description: userPrompt.trim(),
        icon: "calendar-lock",
      };

      return {
        replyText: `C'est compris et reformulé automatiquement dans tes règles : « ${newRule.title} — ${newRule.description} ». Ton plan en tient désormais compte chaque semaine !`,
        reformulatedIntent: `Règle reformulée : ${newRule.title}`,
        safetyStatus: "safe",
        suggestedAction: {
          type: "add_life_rule",
          label: `Règle reformulée & enregistrée : « ${newRule.title} »`,
          applied: true,
          details: "add_life_rule",
          ruleData: newRule,
        },
        modelUsed: "hybrid-rule-engine",
      };
    }

    // Cas C : Gêne musculaire / Mollet / Douleur légère -> Recalcul de la séance et protection de la fin de semaine
    if (
      lowerText.includes("mollet") ||
      lowerText.includes("douleur") ||
      lowerText.includes("gêne") ||
      lowerText.includes("tiraille") ||
      lowerText.includes("blessure")
    ) {
      const recalculated = this.buildRecalculatedWeekForAdaptation(
        athleteContext,
        "injury_care",
        paces,
      );
      return {
        replyText: `Je comprends : tu ressens une gêne musculaire qu'il ne faut surtout pas forcer. Je remplace ta séance du jour par 20 min de mobilité sans impact et j'assouplis automatiquement ta fin de semaine en endurance fondamentale (${easySinglePace}) pour protéger tes fibres.`,
        reformulatedIntent:
          "Adaptation préventive & rééquilibrage de la semaine",
        safetyStatus: "warning_fatigue",
        recalculatedWeekWorkouts: recalculated,
        suggestedAction: {
          type: "reduce_intensity",
          label:
            "Semaine rééquilibrée : Repos mollet & Fin de semaine assouplie",
          applied: true,
          details: "injury_care",
        },
        modelUsed: "hybrid-rule-engine",
      };
    }

    // Cas D : Fatigue / Nuit courte / Jambes lourdes / Problème
    if (
      lowerText.includes("fatigu") ||
      lowerText.includes("crevé") ||
      lowerText.includes("jambes lourdes") ||
      lowerText.includes("mal dormi") ||
      lowerText.includes("nuit") ||
      lowerText.includes("problème") ||
      lowerText.includes("souci")
    ) {
      const recalculated = this.buildRecalculatedWeekForAdaptation(
        athleteContext,
        "lighten",
        paces,
      );
      return {
        replyText: `C'est bien noté. J'ai recalculé ta semaine pour absorber cet imprévu : ta séance du jour passe en footing léger de 35 min en Zone 2 (${paces.easyPaceZ2}) et j'ai ajusté la charge des prochains jours pour que tu restes frais.`,
        reformulatedIntent:
          "Allègement de séance & recalcul dynamique de la semaine",
        safetyStatus: "warning_fatigue",
        recalculatedWeekWorkouts: recalculated,
        suggestedAction: {
          type: "reduce_intensity",
          label:
            "Semaine recalculée : Séance allégée (35 min Z2) & charge lissée",
          applied: true,
          details: "lighten",
        },
        modelUsed: "hybrid-rule-engine",
      };
    }

    // Cas E : Manque de temps ("30 min" / "cool" / "peu de temps")
    if (
      lowerText.includes("cool") ||
      lowerText.includes("30 min") ||
      lowerText.includes("35 min") ||
      lowerText.includes("peu de temps") ||
      lowerText.includes("seulement") ||
      lowerText.includes("souple")
    ) {
      const recalculated = this.buildRecalculatedWeekForAdaptation(
        athleteContext,
        "easy_run",
        paces,
      );
      return {
        replyText: `Parfait, j'adapte ta semaine à ton emploi du temps ! Ta séance passe sur 30 min en Zone 2 (${paces.easyPaceZ2}) aujourd'hui et le reste de ta semaine est rééquilibré automatiquement.`,
        reformulatedIntent: "Séance raccourcie à 30 min & semaine rééquilibrée",
        safetyStatus: "safe",
        recalculatedWeekWorkouts: recalculated,
        suggestedAction: {
          type: "adjust_workout",
          label: "Semaine recalculée : 30 min Z2 aujourd'hui",
          applied: true,
          details: "easy_run",
        },
        modelUsed: "hybrid-rule-engine",
      };
    }

    // Cas F : Imprévu / Décalage à demain
    if (
      lowerText.includes("décaler") ||
      lowerText.includes("imprévu") ||
      lowerText.includes("demain") ||
      lowerText.includes("pas le temps ce soir")
    ) {
      const recalculated = this.buildRecalculatedWeekForAdaptation(
        athleteContext,
        "postpone",
        paces,
      );
      return {
        replyText: `Aucun souci, le plan s'adapte à ta vraie vie sans culpabilité. J'ai placé ton repos aujourd'hui et recalculé la suite de ta semaine en respectant tes règles de vie.`,
        reformulatedIntent:
          "Report de séance & recalcul dynamique de la semaine",
        safetyStatus: "safe",
        recalculatedWeekWorkouts: recalculated,
        suggestedAction: {
          type: "reschedule",
          label: "Semaine recalculée : Repos aujourd'hui & report intelligent",
          applied: true,
          details: "postpone",
        },
        modelUsed: "hybrid-rule-engine",
      };
    }

    // Cas G : Demande d'ajustement du volume kilométrique ou du plan
    if (
      lowerText.includes("plus de km") ||
      lowerText.includes("plus de kilomètre") ||
      lowerText.includes("augmenter le volume") ||
      lowerText.includes("trop court") ||
      lowerText.includes("trop léger") ||
      lowerText.includes("moins de km") ||
      lowerText.includes("moins de kilomètre") ||
      lowerText.includes("réduire le volume") ||
      lowerText.includes("trop de volume") ||
      lowerText.includes("trop long") ||
      lowerText.includes("trop chargé")
    ) {
      const isIncrease =
        lowerText.includes("plus de km") ||
        lowerText.includes("plus de kilomètre") ||
        lowerText.includes("augmenter") ||
        lowerText.includes("trop léger") ||
        lowerText.includes("trop court");

      const { workouts: recalculated, rampClamped, effectiveIncreasePct } =
        this.buildRecalculatedWeekForVolume(
          athleteContext,
          isIncrease ? "increase" : "decrease",
          paces,
        );

      const replyText = isIncrease
        ? rampClamped
          ? `J'ai augmenté ton volume hebdomadaire de +${effectiveIncreasePct} % — plafonné par la règle des +10 % par semaine (moyenne de tes 4 dernières semaines) pour préserver tes tendons. On gardera la tête froide une semaine avant d'en remettre une couche.`
          : `J'ai ajusté ton volume hebdomadaire à la hausse de façon progressive (+${effectiveIncreasePct}%) pour protéger tes tendons et ta récupération. Les séances d'endurance fondamentale et la sortie longue ont été recalculées en conséquence.`
        : `J'ai allégé le volume kilométrique de ta semaine (-15%) suite à ton retour pour préserver ta fraîcheur. Tes séances restent calibrées sur tes allures cibles sans surcharge inutile.`;

      return {
        replyText,
        reformulatedIntent: isIncrease
          ? `Augmentation progressive du volume kilométrique (+${effectiveIncreasePct}%)`
          : "Allègement du volume kilométrique (-15%)",
        safetyStatus: "safe",
        recalculatedWeekWorkouts: recalculated,
        suggestedAction: {
          type: "recalculate_week",
          label: isIncrease
            ? `Volume hebdomadaire augmenté (+${effectiveIncreasePct}% en Z2)`
            : "Volume hebdomadaire allégé (-15%)",
          applied: true,
          details: isIncrease ? "increase_volume" : "decrease_volume",
        },
        modelUsed: "hybrid-rule-engine",
      };
    }

    // Cas H : Réponse centrée sur la séance ciblée (si présente) ou le suivi général
    const goalLabel = athleteContext.activeGoalTitle
      ? `« ${athleteContext.activeGoalTitle}${athleteContext.activeGoalTarget ? ` (${athleteContext.activeGoalTarget})` : ""} »`
      : "ton objectif";

    if (athleteContext.activeWorkout) {
      const act = athleteContext.activeWorkout;
      const dateLabel = act.fullDateLabel || act.dateKey || "cette journée";
      const isDone =
        act.status === "DONE" ||
        act.status === "done" ||
        (act.actualDistanceKm !== undefined && act.actualDistanceKm !== null);

      if (act.isRestDay) {
        return {
          replyText: `Sur ${dateLabel}, tu es en jour de repos : c'est un moment clé d'assimilation physiologique pour absorber ta charge récente et préparer les prochaines séances vers ${goalLabel}. Dis-moi si tu souhaites décaler une séance sur ce créneau !`,
          reformulatedIntent: `Question sur le jour de repos du ${act.dateKey || dateLabel}`,
          safetyStatus: "safe",
          modelUsed: "hybrid-rule-engine",
        };
      }

      if (isDone) {
        const distInfo = act.actualDistanceKm
          ? `${act.actualDistanceKm} km`
          : act.distance || "";
        const paceInfo = act.actualPace ? ` à ${act.actualPace}` : "";
        const hrInfo = act.actualAvgHeartRate
          ? ` (FC moy. ${act.actualAvgHeartRate} bpm)`
          : "";
        return {
          replyText: `Concernant ta séance « ${act.title} » du ${dateLabel} (${distInfo}${paceInfo}${hrInfo}) : c'est une sortie solide qui s'intègre très bien dans ta progression vers ${goalLabel}. Dis-moi comment tu t'es senti pendant l'effort ou si tu veux ajuster la suite !`,
          reformulatedIntent: `Analyse de la séance réalisée « ${act.title} » (${act.dateKey || dateLabel})`,
          safetyStatus: "safe",
          modelUsed: "hybrid-rule-engine",
        };
      }

      const blocksDesc =
        Array.isArray(act.effortBlocks) && act.effortBlocks.length > 0
          ? ` Déroulé : ${act.effortBlocks.map((b) => `${b.title} (${b.durationLabel})`).join(" → ")}.`
          : "";
      const noteDesc = act.aiAdjustmentNote ? ` ${act.aiAdjustmentNote}` : "";
      return {
        replyText: `Pour ta séance « ${act.title} » prévue le ${dateLabel} (${act.distance || act.duration || "au programme"} • Allure cible ${act.targetPace || paces.easyPaceZ2} en ${act.targetZoneLabel || "Zone 2"}) : aborde-la progressivement sans partir trop vite.${blocksDesc}${noteDesc}`,
        reformulatedIntent: `Conseils sur la séance ciblée « ${act.title} » (${act.dateKey || dateLabel})`,
        safetyStatus: "safe",
        modelUsed: "hybrid-rule-engine",
      };
    }

    return {
      replyText: `J'ai bien pris en compte ton message. Ton programme pour ${goalLabel} est calibré sur tes séances récentes (Endurance Z2 : ${paces.easyPaceZ2}, Seuil Z4 : ${paces.thresholdPaceZ4}). Dis-moi si tu as une question sur une séance ou si tu souhaites adapter ta semaine !`,
      reformulatedIntent: "Échange général sur le suivi d'entraînement",
      safetyStatus: "safe",
      modelUsed: "hybrid-rule-engine",
    };
  }

  /**
   * Recalcule dynamiquement le volume des séances restantes de la semaine (augmentation ou réduction)
   */
  private buildRecalculatedWeekForVolume(
    athleteContext: LlmCoachReplyInput["athleteContext"],
    mode: "increase" | "decrease",
    paces: TargetPacesDto,
  ): {
    workouts: NonNullable<LlmCoachReplyOutput["recalculatedWeekWorkouts"]>;
    rampClamped: boolean;
    effectiveIncreasePct: number;
  } {
    const result: NonNullable<LlmCoachReplyOutput["recalculatedWeekWorkouts"]> =
      [];
    const weekWorkouts = athleteContext.currentWeekWorkouts || [];

    // Garde-fou d'entraînement (RILES-023) : la demande « plus dur » vaut
    // +15 % sur la semaine, mais le volume final ne peut jamais dépasser
    // +10 % au-dessus de la moyenne des 4 dernières semaines.
    const parseKm = (distance?: string): number => {
      const m = distance ? distance.replace(",", ".").match(/(\d+(\.\d+)?)/) : null;
      const km = m ? parseFloat(m[1]) : NaN;
      return isNaN(km) ? 0 : km;
    };
    const currentWeekKm = weekWorkouts.reduce(
      (sum, w) => sum + (w.isRestDay ? 0 : parseKm(w.distance)),
      0,
    );
    const referenceKm =
      athleteContext.trainingContext?.recent4WeeksAvgKm ||
      athleteContext.trainingContext?.recentWeeklyKm ||
      currentWeekKm;

    let factor = mode === "increase" ? 1.15 : 0.85;
    let rampClamped = false;
    if (mode === "increase" && currentWeekKm > 0) {
      const clamped = clampWeeklyVolumeRamp(
        currentWeekKm * factor,
        referenceKm,
      );
      if (clamped.clamped) {
        rampClamped = true;
        factor = clamped.km / currentWeekKm;
      }
    }
    const effectiveIncreasePct = Math.round((factor - 1) * 100);
    const easySinglePace = getEasySinglePace(paces);

    for (const w of weekWorkouts) {
      if (w.status === "done" || w.status === "DONE" || w.isRestDay) {
        continue;
      }

      // Extraire la distance numérique
      const currentKm = parseKm(w.distance);
      let newDistStr = w.distance;
      if (currentKm > 0) {
        const newKm = Math.round(currentKm * factor * 10) / 10;
        newDistStr = `${newKm.toString().replace(".", ",")} km`;
      }

      // Extraire la durée
      let newDuration = w.duration;
      const minMatch = w.duration ? w.duration.match(/(\d+)\s*min/) : null;
      const hourMatch = w.duration ? w.duration.match(/(\d+)h(\d+)?/) : null;
      if (hourMatch) {
        const hours = parseInt(hourMatch[1], 10);
        const mins = hourMatch[2] ? parseInt(hourMatch[2], 10) : 0;
        const totalMins = hours * 60 + mins;
        const adjustedMins = Math.round(totalMins * factor);
        const newH = Math.floor(adjustedMins / 60);
        const newM = adjustedMins % 60;
        newDuration =
          newH > 0
            ? `${newH}h${newM < 10 ? "0" + newM : newM}`
            : `${adjustedMins} min`;
      } else if (minMatch) {
        const totalMins = parseInt(minMatch[1], 10);
        const adjustedMins = Math.round(totalMins * factor);
        newDuration = `${adjustedMins} min`;
      }

      const note =
        mode === "increase"
          ? rampClamped
            ? `Volume ajusté à la hausse (+${effectiveIncreasePct}%) — j'ai plafonné ta semaine pour rester sous la règle des +10 % hebdomadaires et protéger tes tendons.`
            : `Volume ajusté à la hausse (+${effectiveIncreasePct}%) en restant en Zone 2 pour assimiler la charge sans risque.`
          : `Volume allégé (-15%) à ta demande pour optimiser la fraîcheur et la récupération.`;

      result.push({
        dateKey: w.dateKey,
        isRestDay: false,
        category: w.title.toLowerCase().includes("longue")
          ? "SORTIE LONGUE"
          : "ENDURANCE FONDAMENTALE",
        title: `${w.title.replace(/\s*\(Volume adapté\)/g, "")} (Volume adapté)`,
        duration: newDuration,
        distance: newDistStr,
        targetPace: w.targetPace || easySinglePace,
        targetZoneLabel: "Zone 2",
        targetZoneBpm: "135–148 bpm",
        aiAdjustmentNote: note,
        tags: [
          newDistStr,
          newDuration,
          mode === "increase"
            ? `Volume +${effectiveIncreasePct}%`
            : "Volume -15%",
        ],
      });
    }

    return { workouts: result, rampClamped, effectiveIncreasePct };
  }

  /**
   * Recalcule dynamiquement la séance active ET rééquilibre les séances restantes de la semaine
   * en respectant les jours bloqués (LifeRules)
   */
  private buildRecalculatedWeekForAdaptation(
    athleteContext: LlmCoachReplyInput["athleteContext"],
    mode: "lighten" | "easy_run" | "postpone" | "injury_care",
    paces: TargetPacesDto,
  ): NonNullable<LlmCoachReplyOutput["recalculatedWeekWorkouts"]> {
    const result: NonNullable<LlmCoachReplyOutput["recalculatedWeekWorkouts"]> =
      [];
    const activeDateKey =
      athleteContext.activeWorkout?.dateKey ||
      athleteContext.todayDate ||
      new Date().toISOString().split("T")[0];
    const easySinglePace = getEasySinglePace(paces);
    const lockedDays = this.getLockedDayNamesFromRules(
      athleteContext.rules || [],
    );

    if (mode === "lighten") {
      result.push({
        dateKey: activeDateKey,
        isRestDay: false,
        category: "ENDURANCE FONDAMENTALE",
        title: "Footing Léger & Lignes Droites (Adapté)",
        duration: "35 min",
        distance: "6,0 km",
        targetPace: easySinglePace,
        targetZoneLabel: "Zone 2",
        targetZoneBpm: "135–148 bpm",
        aiAdjustmentNote: `Séance allégée (${easySinglePace}) et semaine rééquilibrée.`,
        tags: ["6,0 km", `Allure : ${easySinglePace}`, "Zone 2"],
      });
    } else if (mode === "easy_run") {
      result.push({
        dateKey: activeDateKey,
        isRestDay: false,
        category: "RÉCUPÉRATION ACTIVE",
        title: "30 min Footing Souple Régénérant (Adapté)",
        duration: "30 min",
        distance: "5,0 km",
        targetPace: easySinglePace,
        targetZoneLabel: "Zone 1–2",
        targetZoneBpm: "128–142 bpm",
        aiAdjustmentNote: `Séance raccourcie à 30 min (${easySinglePace}) suite à ton message.`,
        tags: ["5,0 km", "Endurance fondamentale", "Zone 1/2"],
      });
    } else if (mode === "injury_care") {
      result.push({
        dateKey: activeDateKey,
        isRestDay: false,
        category: "RENFORCEMENT & MOBILITÉ",
        title: "Mobilité douce & Prévention Sans Impact (Adapté)",
        duration: "20 min",
        distance: "0 km",
        targetPace: "—",
        targetZoneLabel: "Zone 1",
        targetZoneBpm: "< 115 bpm",
        aiAdjustmentNote:
          "Course remplacée par 20 min de mobilité douce ; séance suivante assouplie.",
        tags: ["20 min", "Sans impact", "Prévention"],
      });
    } else if (mode === "postpone") {
      result.push({
        dateKey: activeDateKey,
        isRestDay: true,
        category: "RÉCUPÉRATION PASSIVE",
        title: "Repos / Imprévu (Séance reportée)",
        duration: "—",
        distance: "0 km",
        targetPace: "—",
        targetZoneLabel: "Zone 1",
        targetZoneBpm: "< 110 bpm",
        aiAdjustmentNote:
          "Repos placé aujourd'hui suite à ton imprévu ; séance proposée sur le prochain jour disponible.",
        tags: ["Repos adapté", "Zéro culpabilité"],
      });
    }

    // Rééquilibrage automatique des jours suivants de la semaine (sans toucher aux séances DONE ni aux LifeRules)
    const weekWorkouts = athleteContext.currentWeekWorkouts || [];
    for (const w of weekWorkouts) {
      if (
        w.dateKey <= activeDateKey ||
        w.status === "done" ||
        w.status === "DONE"
      ) {
        continue;
      }
      if (lockedDays.has(w.dayName) || w.isRestDay) {
        continue;
      }

      if (mode === "injury_care" || mode === "lighten") {
        // Assouplissement préventif de la séance suivante pour éviter tout rebond de fatigue
        result.push({
          dateKey: w.dateKey,
          isRestDay: false,
          category: "ENDURANCE FONDAMENTALE",
          title: `${w.title.replace(/\s*\(Rééquilibré\)/g, "")} (Rééquilibré)`,
          duration: w.duration === "1h30" ? "1h10" : "45 min",
          distance: w.distance === "16,0 km" ? "12,0 km" : "8,0 km",
          targetPace: easySinglePace,
          targetZoneLabel: "Zone 2",
          targetZoneBpm: "135–148 bpm",
          aiAdjustmentNote:
            "Charge lissée pour respecter ton état de forme de la semaine.",
          tags: ["Rééquilibré", `Allure : ${easySinglePace}`, "Zone 2"],
        });
        break;
      } else if (mode === "postpone") {
        // Report de la qualité sur le prochain jour disponible non verrouillé
        result.push({
          dateKey: w.dateKey,
          isRestDay: false,
          category: "SÉANCE QUALITATIVE",
          title: `${athleteContext.activeWorkout?.title || "Séance Seuil"} (Reportée)`,
          duration: athleteContext.activeWorkout?.duration || "1h05",
          distance: athleteContext.activeWorkout?.distance || "12,0 km",
          targetPace: paces.thresholdPaceZ4,
          targetZoneLabel: "Zone 3–4",
          targetZoneBpm: "158–172 bpm",
          aiAdjustmentNote:
            "Séance reportée ici en respectant tes jours sanctuarisés.",
          tags: ["Report", `Seuil : ${paces.thresholdPaceZ4}`, "Zone 3/4"],
        });
        break;
      }
    }

    return result;
  }

  // ============================================================================
  // 7. CLIENT HTTP UNIVERSEL COMPATIBLE OPENAI / OMNIROUTE / GEMINI / OPENROUTER
  // ============================================================================

  private canCallExternalLlm(): boolean {
    return Boolean(this.apiKey) || this.isOmniRouteLocal;
  }

  private async callOpenAiCompatibleJson<T>(
    model: string,
    systemPrompt: string,
    userMessage: string,
    timeoutMs = 8000,
  ): Promise<T | null> {
    const url = `${this.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.apiKey) {
      headers["Authorization"] = `Bearer ${this.apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        signal: controller.signal,
        body: JSON.stringify({
          model,
          temperature: 0.3,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
        }),
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        if (
          (response.status === 503 || response.status === 429) &&
          model !== this.lightModel
        ) {
          this.logger.warn(
            `Modèle ${model} temporairement indisponible (HTTP ${response.status}), bascule automatique sur ${this.lightModel}...`,
          );
          return this.callOpenAiCompatibleJson<T>(
            this.lightModel,
            systemPrompt,
            userMessage,
            timeoutMs,
          );
        }
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`);
      }

      const data: any = await response.json();
      const rawContent: string = data?.choices?.[0]?.message?.content || "";

      if (!rawContent) {
        return null;
      }

      // Nettoyage robuste des balises markdown ```json éventuelles
      const cleaned = rawContent
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/\s*```$/i, "")
        .trim();

      return JSON.parse(cleaned) as T;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private buildFallbackGoalExtraction(rawGoal: string): ExtractedGoalDto {
    const lower = rawGoal.toLowerCase();
    let title = "Semi-marathon";
    let distanceKm = 21.1;

    if (lower.includes("paris") && lower.includes("semi")) {
      title = "Semi-marathon de Paris";
    } else if (lower.includes("paris") && lower.includes("marathon")) {
      title = "Marathon de Paris";
      distanceKm = 42.2;
    } else if (lower.includes("ultra")) {
      const kmMatch = lower.match(/(\d{2,3})\s*km/i);
      distanceKm = kmMatch ? parseInt(kmMatch[1], 10) : 100;
      title = `Ultra-Trail (${distanceKm} km)`;
    } else if (lower.includes("marathon") && !lower.includes("semi")) {
      title = "Préparation Marathon";
      distanceKm = 42.2;
    } else if (lower.includes("10 km") || lower.includes("10km")) {
      title = "Course 10 km";
      distanceKm = 10;
    }

    const chronoMatch = lower.match(/(\d\s*h\s*\d{0,2}|\d{2}\s*min)/i);
    const target = chronoMatch
      ? `Objectif ${chronoMatch[1].replace(/\s+/g, "")}`
      : lower.includes("sans me blesser")
        ? "Finir sereinement sans blessure"
        : "Passer sous les 2h";

    let weeksRemaining = 16;
    let raceDate = "Dans 16 semaines (4 mois)";

    const now = new Date();
    const monthsFr: Record<string, number> = {
      janvier: 0,
      février: 1,
      fevrier: 1,
      mars: 2,
      avril: 3,
      mai: 4,
      juin: 5,
      juillet: 6,
      août: 7,
      aout: 7,
      septembre: 8,
      octobre: 9,
      novembre: 10,
      décembre: 11,
      decembre: 11,
    };

    const textDateMatch = lower.match(/(\d{1,2})\s+([a-zéû]+)\s+(\d{4})/i);
    const frMatch = lower.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
    const isoMatch = lower.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);

    if (textDateMatch && monthsFr[textDateMatch[2]] !== undefined) {
      const d = new Date(
        parseInt(textDateMatch[3], 10),
        monthsFr[textDateMatch[2]],
        parseInt(textDateMatch[1], 10),
      );
      if (!isNaN(d.getTime()) && d > now) {
        weeksRemaining = Math.max(
          1,
          Math.round((d.getTime() - now.getTime()) / (7 * 24 * 3600 * 1000)),
        );
        raceDate = d.toLocaleDateString("fr-FR", {
          day: "numeric",
          month: "long",
          year: "numeric",
        });
      }
    } else if (frMatch) {
      const d = new Date(
        parseInt(frMatch[3], 10),
        parseInt(frMatch[2], 10) - 1,
        parseInt(frMatch[1], 10),
      );
      if (!isNaN(d.getTime()) && d > now) {
        weeksRemaining = Math.max(
          1,
          Math.round((d.getTime() - now.getTime()) / (7 * 24 * 3600 * 1000)),
        );
        raceDate = d.toLocaleDateString("fr-FR", {
          day: "numeric",
          month: "long",
          year: "numeric",
        });
      }
    } else if (isoMatch) {
      const d = new Date(
        parseInt(isoMatch[1], 10),
        parseInt(isoMatch[2], 10) - 1,
        parseInt(isoMatch[3], 10),
      );
      if (!isNaN(d.getTime()) && d > now) {
        weeksRemaining = Math.max(
          1,
          Math.round((d.getTime() - now.getTime()) / (7 * 24 * 3600 * 1000)),
        );
        raceDate = d.toLocaleDateString("fr-FR", {
          day: "numeric",
          month: "long",
          year: "numeric",
        });
      }
    } else {
      let matchedMonth = false;
      for (const [mName, mIdx] of Object.entries(monthsFr)) {
        if (lower.includes(mName)) {
          matchedMonth = true;
          let targetYear = now.getFullYear();
          if (mIdx <= now.getMonth()) {
            targetYear += 1;
          }
          const targetDay = 21; // Marathon ciblé le 3ème dimanche du mois
          const d = new Date(targetYear, mIdx, targetDay);
          weeksRemaining = Math.max(
            4,
            Math.round((d.getTime() - now.getTime()) / (7 * 24 * 3600 * 1000)),
          );
          raceDate = d.toLocaleDateString("fr-FR", {
            day: "numeric",
            month: "long",
            year: "numeric",
          });
          break;
        }
      }

      if (!matchedMonth) {
        const monthsMatch = lower.match(/(\d+)\s*mois/i);
        const weeksMatch = lower.match(/(\d+)\s*semaine/i);
        if (weeksMatch) {
          weeksRemaining = parseInt(weeksMatch[1], 10);
          raceDate = `Dans ${weeksRemaining} semaines`;
        } else if (monthsMatch) {
          weeksRemaining = parseInt(monthsMatch[1], 10) * 4;
          raceDate = `Dans ${weeksRemaining} semaines`;
        }
      }
    }

    return {
      title,
      target,
      raceDate,
      weeksRemaining,
      distanceKm,
    };
  }
}
