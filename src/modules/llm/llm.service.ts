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
        ((distanceKm >= 60 && (effectiveWeeklyKm >= 50 || longestRecentRunKm >= 28)) ||
          (distanceKm >= 40 && distanceKm < 60 && (effectiveWeeklyKm >= 38 || longestRecentRunKm >= 22))))
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
        status: distanceKm >= 60 && weeksAvailable <= 12 ? "CONTEXT_NEEDED" : "ELIGIBLE",
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
   */
  public computePacesFromRecentPerformance(
    trainingContext?: AthleteTrainingContextDto,
  ): TargetPacesDto {
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
    const sessions = trainingContext?.recentSessions || [];
    if (sessions.length > 0) {
      const hrMax =
        trainingContext?.hrMax ||
        Math.max(
          188,
          ...sessions.map((s) => s.maxHeartRate || 0),
        );

      let weightedThresholdSum = 0;
      let totalWeight = 0;

      for (const session of sessions) {
        if (!session.avgPaceSecPerKm || session.avgPaceSecPerKm <= 0) continue;
        const weight = Math.max(1, session.distanceKm || 5);

        if (session.avgHeartRate && session.avgHeartRate > 95) {
          // Ratio d'intensité cardiaque de la séance (ex: 145 bpm / 190 bpm = 0.763 -> 76.3% FCmax)
          const hrRatio = Math.min(0.98, Math.max(0.6, session.avgHeartRate / hrMax));
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
    }>,
  ): AthleteTrainingContextDto["recentSessions"] {
    const metrics: NonNullable<AthleteTrainingContextDto["recentSessions"]> = [];

    for (const w of workouts) {
      if (w.isRestDay) continue;

      const paceStr = w.actualPace || w.targetPace;
      if (!paceStr) continue;

      const paceMatch = paceStr.match(/(\d+):(\d{2})/);
      if (!paceMatch) continue;
      const avgPaceSecPerKm =
        parseInt(paceMatch[1], 10) * 60 + parseInt(paceMatch[2], 10);

      // Priorité à la vraie fréquence cardiaque moyenne mesurée par la montre
      let avgHeartRate: number | undefined =
        w.actualAvgHeartRate ?? undefined;
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
        distanceKm = distMatch
          ? parseFloat(distMatch[1].replace(",", "."))
          : 8;
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
    const freqMatch = lower.match(/(\d)\s*(séances?|fois)\s*(par|\/)\s*semaine/i);
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
    "raceDate": "string (ex: Dans 12 semaines)",
    "weeksRemaining": number
  },
  "extractedRules": [
    { "title": "string", "description": "string", "icon": "calendar-lock | clock-outline | bullseye-arrow | sleep" }
  ]
}`;

        const llmJson = await this.callOpenAiCompatibleJson<{
          reformulatedGoal?: string;
          extractedGoal?: ExtractedGoalDto;
          extractedRules?: ExtractedRuleDto[];
        }>(this.lightModel, systemPrompt, `Objectif utilisateur : "${rawGoal}"`);

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
    const { userPrompt, athleteContext } = input;

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
1. Reformule toujours automatiquement l'intention de l'utilisateur dès le début de ta réponse ("reformulatedIntent" et première phrase de "replyText").
2. Zéro culpabilisation : valorise toujours l'écoute du corps et le repos quand il est plus rentable qu'une séance forcée.
3. Si l'utilisateur exprime une contrainte durable ou une règle de vie (ex: "je ne peux jamais courir le jeudi", "pas plus de 45 min en semaine", "ajoute une règle..."), reformule-la automatiquement et renvoie un suggestedAction avec type="add_life_rule", details="add_life_rule" et ruleData={ title, description, icon }.
4. Si l'utilisateur signale un problème, un imprévu, une fatigue, un manque de temps ou une gêne musculaire, recalcule dynamiquement sa séance du jour ET rééquilibre les séances restantes de sa semaine ("recalculatedWeekWorkouts") en respectant ses règles de vie (jours bloqués) et choisis parmi ces details autorisés :
   - "lighten" (raccourcir/alléger à 35 min Zone 2 et lisser la semaine)
   - "easy_run" (remplacer par 30 min footing régénérant Zone 1-2)
   - "postpone" (décaler la séance et réorganiser les jours suivants)
   - "injury_care" (20 min mobilité douce sans impact et assouplir la fin de semaine)
5. Ne calcule JAMAIS les allures à partir de l'objectif rêvé. Respecte strictement les allures physiologiques calculées sur les séances récentes et la fréquence cardiaque de l'athlète : Endurance Z2=${paces.easyPaceZ2}, Allure Marathon Z3=${paces.marathonPaceZ3}, Seuil Z4=${paces.thresholdPaceZ4}, VMA Z5=${paces.intervalPaceZ5}.
6. Pour tout objectif ambitieux (ex: Ultra, Marathon), juge sa faisabilité UNIQUEMENT par rapport au contexte d'entraînement réel de l'athlète (s'il est déjà en milieu de prépa avec le bon volume, valide-le à 100 %).

CONTEXTE ATHLÈTE COMPLET (incluant currentWeekWorkouts) :
${JSON.stringify(athleteContext)}

Réponds UNIQUEMENT avec un objet JSON valide :
{
  "replyText": "string (ta réponse bienveillante en français, 2 à 4 phrases max, commençant par reformuler automatiquement ce que tu as compris et expliquant comment tu as recalculé sa semaine)",
  "reformulatedIntent": "string (résumé court de la demande)",
  "safetyStatus": "safe | warning_fatigue | medical_stop | unrealistic_goal",
  "suggestedAction": {
    "type": "adjust_workout | reschedule | reduce_intensity | add_life_rule | recalculate_week",
    "label": "string (ex: Semaine recalculée : Séance allégée & fin de semaine ajustée)",
    "applied": true,
    "details": "lighten | easy_run | postpone | injury_care | add_life_rule",
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

        const parsed = await this.callOpenAiCompatibleJson<{
          replyText?: string;
          reformulatedIntent?: string;
          safetyStatus?: any;
          suggestedAction?: any;
          recalculatedWeekWorkouts?: LlmCoachReplyOutput["recalculatedWeekWorkouts"];
        }>(selectedModel, systemPrompt, userPrompt);

        if (parsed && parsed.replyText) {
          return {
            replyText: parsed.replyText,
            reformulatedIntent: parsed.reformulatedIntent,
            safetyStatus: parsed.safetyStatus || "safe",
            suggestedAction: parsed.suggestedAction || undefined,
            recalculatedWeekWorkouts: parsed.recalculatedWeekWorkouts,
            modelUsed: selectedModel,
          };
        }
      } catch (err: any) {
        this.logger.warn(
          `Fallback moteur hybride local pour generateCoachReply (${err?.message})`,
        );
      }
    }

    // 5. Moteur Hybride Local Intelligent (0 ms, fonctionne même hors-ligne / sans clé)
    return this.generateDeterministicCoachReply(userPrompt, athleteContext, paces);
  }

  // ============================================================================
  // 5. GÉNÉRATEUR DE PLAN MULTI-SEMAINES PAR LLM PRO (AVEC CONTEXTE COMPLET & LIFE RULES)
  // ============================================================================

  /**
   * Calcule le Training Stress Score (hrTSS / Banister TRIMP normalisé) d'une séance
   */
  public computeSessionTss(
    durationSec: number,
    avgHeartRate?: number,
    hrMax = 190,
  ): number {
    if (!durationSec || durationSec <= 0) return 0;
    const hours = durationSec / 3600;
    const hrRatio = avgHeartRate ? Math.min(1, Math.max(0.55, avgHeartRate / hrMax)) : 0.75;
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
  public updateBanisterLoad(
    currentAtl: number,
    currentCtl: number,
    sessionTss: number,
  ): {
    atlFatigue: number;
    ctlFitness: number;
    tsbForm: number;
    readinessScore: number;
  } {
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

  /**
   * Détecte les jours de la semaine verrouillés dans les LifeRules de l'utilisateur
   */
  public getLockedDayNamesFromRules(
    lifeRules: Array<{ title: string; description: string }>,
  ): Set<string> {
    const lockedShortDays = new Set<string>();
    const combinedText = lifeRules
      .map((r) => `${r.title} ${r.description}`.toLowerCase())
      .join(" ");

    const mapDayToShort: Record<string, string> = {
      lundi: "Lun",
      mardi: "Mar",
      mercredi: "Mer",
      jeudi: "Jeu",
      vendredi: "Ven",
      samedi: "Sam",
      dimanche: "Dim",
    };

    for (const [fullDay, shortDay] of Object.entries(mapDayToShort)) {
      if (combinedText.includes(fullDay)) {
        lockedShortDays.add(shortDay);
      }
    }
    return lockedShortDays;
  }

  /**
   * Génère un plan d'entraînement multi-semaines complet via le meilleur modèle (LLM_PRO_MODEL)
   * en lui fournissant TOUT le contexte de l'athlète, ses vraies allures (issues des séances récentes & FC)
   * et ses LifeRules, au format exact requis pour insertion directe en base de données.
   */
  async generateMultiWeekPlan(
    input: any,
  ): Promise<{
    planSummary: string;
    modelUsed: string;
    workouts: any[];
  }> {
    const lockedDays = this.getLockedDayNamesFromRules(input.lifeRules || []);
    const paces = input.calculatedPaces;

    if (this.canCallExternalLlm()) {
      try {
        const systemPrompt = `Tu es le Directeur de la Performance et Coach IA de Riles.
Ta mission est de générer un plan d'entraînement multi-semaines COMPLET, individualisé et périodisé pour l'athlète, directement insérable dans notre base de données PostgreSQL.

RÈGLES ABSOLUES DE CONSTRUCTION DU PLAN :
1. RESPECT STRICT DES RÈGLES DE VIE (LIFE RULES) :
   - Jours bloqués / sanctuarisés détectés : ${Array.from(lockedDays).join(", ") || "Aucun jour fixe bloqué"}.
   - Sur chaque jour bloqué par une LifeRule, tu DOIS impérativement mettre "isRestDay": true, "category": "RÉCUPÉRATION PASSIVE", "title": "Repos complet (Règle de vie respectée)", "duration": "—", "distance": "0 km".
2. RESPECT DES ALLURES PHYSIOLOGIQUES RÉELLES (CALCULÉES SUR SES SÉANCES RÉCENTES & FC) :
   - Endurance fondamentale (Zone 2) : ${paces.easyPaceZ2} (132–148 bpm)
   - Allure Marathon / Tempo (Zone 3) : ${paces.marathonPaceZ3} (150–160 bpm)
   - Allure Seuil Anaérobie (Zone 4) : ${paces.thresholdPaceZ4} (162–174 bpm)
   - Allure VMA / Intervalle (Zone 5) : ${paces.intervalPaceZ5} (176–188 bpm)
3. PROGRESSIVITÉ & PÉRIODISATION SCIENTIFIQUE :
   - Ne dépasse jamais +10 % d'augmentation de volume hebdomadaire d'une semaine à l'autre.
   - Alterne judicieusement séances d'endurance fondamentale (80 % du volume), séance qualitative au seuil/VMA, renforcement/mobilité et sortie longue le week-end.
   - Tiens compte de sa fatigue actuelle (ATL=${input.physiologicalState.atlFatigue}, CTL=${input.physiologicalState.ctlFitness}, TSB=${input.physiologicalState.tsbForm}, Readiness=${input.physiologicalState.readinessScore}%).

CONTEXTE COMPLET DE L'ATHLÈTE :
${JSON.stringify({
  userProfile: input.userProfile,
  physiologicalState: input.physiologicalState,
  calculatedPaces: input.calculatedPaces,
  lifeRules: input.lifeRules,
  recentCompletedSessions: input.recentCompletedSessions,
})}

CRÉNEAUX CALENDAIRES EXACTS À REMPLIR (1 objet workout par créneau dateKey) :
${JSON.stringify(input.calendarSlots)}

Réponds UNIQUEMENT avec un objet JSON strictement valide au format suivant :
{
  "planSummary": "string (Présentation claire et motivante du plan généré sur plusieurs semaines, expliquant la logique de progression et le respect de ses règles de vie)",
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
      "aiAdjustmentNote": "string (explication personnalisée du coach IA pour cette séance)",
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
          `Génère le plan multi-semaines complet pour ${input.userProfile.name} (${input.calendarSlots.length} jours).`,
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
            return this.normalizeGeneratedWorkout(
              slot,
              found,
              lockedDays,
              paces,
            );
          });

          return {
            planSummary:
              llmPlan.planSummary ||
              `Plan multi-semaines généré par ${this.proModel} pour « ${input.userProfile.activeGoalTitle} » en respectant tes règles de vie et tes allures réelles (Z2 ${paces.easyPaceZ2}, Seuil ${paces.thresholdPaceZ4}).`,
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

    return this.generatePeriodizedMultiWeekFallback(input, lockedDays, paces);
  }

  private normalizeGeneratedWorkout(
    slot: any,
    raw: any,
    lockedDays: Set<string>,
    paces: TargetPacesDto,
  ): any {
    const isLockedByRule = lockedDays.has(slot.dayName);
    const isRest = isLockedByRule || Boolean(raw?.isRestDay);

    if (isRest) {
      return {
        ...slot,
        timeLabel: "Jour de repos",
        isRestDay: true,
        category: "RÉCUPÉRATION PASSIVE",
        title: isLockedByRule
          ? `Repos sanctuarisé (${slot.dayName} bloqué)`
          : raw?.title || "Repos complet & Régénération",
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
          ? ["Règle de vie respectée", "Repos"]
          : ["Récupération", "Hydratation"],
        aiAdjustmentNote: isLockedByRule
          ? `Règle de vie appliquée : aucune séance programmée le ${slot.dayName.toLowerCase()}.`
          : raw?.aiAdjustmentNote ||
            "Journée d'assimilation physiologique pour consolider tes progrès.",
        tss: 0,
      };
    }

    const easySinglePace = paces.easyPaceZ2.split("–")[0]?.trim() || "5:45/km";
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

  private generatePeriodizedMultiWeekFallback(
    input: any,
    lockedDays: Set<string>,
    paces: TargetPacesDto,
  ): {
    planSummary: string;
    modelUsed: string;
    workouts: any[];
  } {
    const easySinglePace = paces.easyPaceZ2.split("–")[0]?.trim() || "5:45/km";
    const slots: any[] = input.calendarSlots || [];
    const distinctWeeks = Array.from(new Set(slots.map((s) => s.weekNumber)));

    const workouts = slots.map((slot) => {
      const weekIndex = Math.max(0, distinctWeeks.indexOf(slot.weekNumber));
      // Semaine d'assimilation (deload) toutes les 4 semaines, sinon progression douce +6%/sem
      const isDeloadWeek = (weekIndex + 1) % 4 === 0;
      const progressionFactor = isDeloadWeek ? 0.82 : 1 + weekIndex * 0.06;

      if (lockedDays.has(slot.dayName)) {
        return this.normalizeGeneratedWorkout(slot, { isRestDay: true }, lockedDays, paces);
      }

      if (slot.dayName === "Lun") {
        const dist = (7.0 * progressionFactor).toFixed(1).replace(".", ",");
        const dur = Math.round(40 * progressionFactor);
        return this.normalizeGeneratedWorkout(
          slot,
          {
            timeLabel: "18:00",
            isRestDay: false,
            category: "ENDURANCE FONDAMENTALE",
            title: `Footing Fondamental Z2 (${dist} km)`,
            duration: `${dur} min`,
            distance: `${dist} km`,
            targetPace: easySinglePace,
            targetZoneLabel: "Zone 2",
            targetZoneBpm: "134–146 bpm",
            pinPositionPercent: 35,
            tags: [`${dist} km`, `Allure : ${easySinglePace}`, "Zone 2"],
            aiAdjustmentNote:
              "Séance aérobie calibrée sur ta fréquence cardiaque récente.",
            tss: Math.round(38 * progressionFactor),
          },
          lockedDays,
          paces,
        );
      }

      if (slot.dayName === "Mar") {
        return this.normalizeGeneratedWorkout(
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
              "Renforcement ciblé pour absorber la charge sans fatigue tendineuse.",
            tss: 22,
          },
          lockedDays,
          paces,
        );
      }

      if (slot.dayName === "Mer") {
        const reps = isDeloadWeek ? 2 : 3 + Math.min(2, Math.floor(weekIndex / 2));
        const dist = (11.5 * progressionFactor).toFixed(1).replace(".", ",");
        return this.normalizeGeneratedWorkout(
          slot,
          {
            timeLabel: "18:30",
            isRestDay: false,
            category: "SÉANCE QUALITATIVE",
            title: `Séance Seuil ${reps} × 8 min (${paces.thresholdPaceZ4})`,
            duration: "1h05",
            distance: `${dist} km`,
            targetPace: paces.thresholdPaceZ4,
            targetZoneLabel: "Zone 3–4",
            targetZoneBpm: "160–173 bpm",
            pinPositionPercent: 68,
            tags: [
              `${dist} km`,
              `Seuil : ${paces.thresholdPaceZ4}`,
              "Zone 3/4",
            ],
            aiAdjustmentNote: `Séance clé calibrée sur ton seuil actuel (${paces.thresholdPaceZ4}) issu de tes dernières sorties.`,
            tss: Math.round(68 * progressionFactor),
          },
          lockedDays,
          paces,
        );
      }

      if (slot.dayName === "Jeu") {
        return this.normalizeGeneratedWorkout(
          slot,
          { isRestDay: true },
          lockedDays,
          paces,
        );
      }

      if (slot.dayName === "Ven") {
        const dist = (9.5 * progressionFactor).toFixed(1).replace(".", ",");
        return this.normalizeGeneratedWorkout(
          slot,
          {
            timeLabel: "12:30",
            isRestDay: false,
            category: "ALLURE SPÉCIFIQUE",
            title: `Footing Progressif & Rappels d'Allure (${paces.marathonPaceZ3})`,
            duration: "50 min",
            distance: `${dist} km`,
            targetPace: paces.marathonPaceZ3,
            targetZoneLabel: "Zone 3",
            targetZoneBpm: "150–162 bpm",
            pinPositionPercent: 56,
            tags: [`${dist} km`, `Allure : ${paces.marathonPaceZ3}`, "Zone 3"],
            aiAdjustmentNote:
              "Travail d'économie de course avant la sortie longue du week-end.",
            tss: Math.round(54 * progressionFactor),
          },
          lockedDays,
          paces,
        );
      }

      if (slot.dayName === "Sam") {
        const dist = (15.0 * progressionFactor).toFixed(1).replace(".", ",");
        const mins = Math.round(85 * progressionFactor);
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        return this.normalizeGeneratedWorkout(
          slot,
          {
            timeLabel: "09:00",
            isRestDay: false,
            category: "SORTIE LONGUE",
            title: `Sortie Longue Endurance (${dist} km)`,
            duration: `${h}h${String(m).padStart(2, "0")}`,
            distance: `${dist} km`,
            targetPace: easySinglePace,
            targetZoneLabel: "Zone 2",
            targetZoneBpm: "136–150 bpm",
            pinPositionPercent: 45,
            tags: [`${dist} km`, `Endurance : ${easySinglePace}`, "Zone 2"],
            aiAdjustmentNote: isDeloadWeek
              ? "Semaine d'assimilation : volume réduit de 18 % pour surcompenser."
              : "Sortie fondamentale progressive (+10 % max/semaine respecté).",
            tss: Math.round(78 * progressionFactor),
          },
          lockedDays,
          paces,
        );
      }

      return this.normalizeGeneratedWorkout(
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
        ? `Tes jours sanctuarisés (${Array.from(lockedDays).join(", ")}) sont strictement verrouillés en repos.`
        : "Tes règles de vie sont intégrées sur chaque semaine.";

    return {
      planSummary: `Plan multi-semaines (${distinctWeeks.length} semaines) généré pour « ${input.userProfile.activeGoalTitle} (${input.userProfile.activeGoalTarget}) ». Allures calibrées sur tes vraies séances & FC (Z2 : ${paces.easyPaceZ2}, Seuil : ${paces.thresholdPaceZ4}). ${lockedInfo}`,
      modelUsed: `${this.proModel}-periodized-engine`,
      workouts,
    };
  }

  // ============================================================================
  // 6. MOTEUR DE FALLBACK DÉTERMINISTE ENRICHI (RÈGLES DE VIE + RECALCUL SEMAINE)
  // ============================================================================

  private generateDeterministicCoachReply(
    userPrompt: string,
    athleteContext: LlmCoachReplyInput["athleteContext"],
    paces: TargetPacesDto,
  ): LlmCoachReplyOutput {
    const lowerText = userPrompt.toLowerCase();
    const userName = athleteContext.userName || "Marius";
    const easySinglePace = paces.easyPaceZ2.split("–")[0]?.trim() || "5:45/km";

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
          ? currentRules.map((r) => `• ${r.title} : ${r.description}`).join("\n")
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
      const newRule: ExtractedRuleDto =
        extractedRules[0] || {
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
        reformulatedIntent: "Adaptation préventive & rééquilibrage de la semaine",
        safetyStatus: "warning_fatigue",
        recalculatedWeekWorkouts: recalculated,
        suggestedAction: {
          type: "reduce_intensity",
          label: "Semaine rééquilibrée : Repos mollet & Fin de semaine assouplie",
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
        replyText: `C'est bien noté ${userName}. J'ai recalculé ta semaine pour absorber cet imprévu : ta séance du jour passe en footing léger de 35 min en Zone 2 (${paces.easyPaceZ2}) et j'ai ajusté la charge des prochains jours pour que tu restes frais.`,
        reformulatedIntent: "Allègement de séance & recalcul dynamique de la semaine",
        safetyStatus: "warning_fatigue",
        recalculatedWeekWorkouts: recalculated,
        suggestedAction: {
          type: "reduce_intensity",
          label: "Semaine recalculée : Séance allégée (35 min Z2) & charge lissée",
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
        replyText: `Parfait ${userName}, j'adapte ta semaine à ton emploi du temps ! Ta séance passe sur 30 min en Zone 2 (${paces.easyPaceZ2}) aujourd'hui et le reste de ta semaine est rééquilibré automatiquement.`,
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
        replyText: `Aucun souci ${userName}, le plan s'adapte à ta vraie vie sans culpabilité. J'ai placé ton repos aujourd'hui et recalculé la suite de ta semaine en respectant tes règles de vie.`,
        reformulatedIntent: "Report de séance & recalcul dynamique de la semaine",
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

    // Cas G : Réponse générale contextualisée
    return {
      replyText: `J'ai bien pris en compte ton message ${userName}. Ton programme pour « ${athleteContext.activeGoalTitle || "Semi-marathon"} (${athleteContext.activeGoalTarget || "sous les 2h"}) » est calibré sur tes séances récentes (Endurance Z2 : ${paces.easyPaceZ2}, Seuil Z4 : ${paces.thresholdPaceZ4}). Dis-moi si tu as un imprévu ou une fatigue et je recalcule ta semaine automatiquement !`,
      reformulatedIntent: "Échange général sur le suivi d'entraînement",
      safetyStatus: "safe",
      modelUsed: "hybrid-rule-engine",
    };
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
    const result: NonNullable<LlmCoachReplyOutput["recalculatedWeekWorkouts"]> = [];
    const activeDateKey = athleteContext.activeWorkout?.dateKey || "2026-10-14";
    const easySinglePace = paces.easyPaceZ2.split("–")[0]?.trim() || "5:45/km";
    const lockedDays = this.getLockedDayNamesFromRules(
      athleteContext.rules || [],
    );

    if (mode === "lighten") {
      result.push({
        dateKey: activeDateKey,
        isRestDay: false,
        category: "ENDURANCE FONDAMENTALE",
        title: "Footing Léger & Lignes Droites (Adapté IA)",
        duration: "35 min",
        distance: "6,0 km",
        targetPace: easySinglePace,
        targetZoneLabel: "Zone 2",
        targetZoneBpm: "135–148 bpm",
        aiAdjustmentNote: `Séance allégée (${easySinglePace}) et semaine rééquilibrée par le Coach IA.`,
        tags: ["6,0 km", `Allure : ${easySinglePace}`, "Zone 2"],
      });
    } else if (mode === "easy_run") {
      result.push({
        dateKey: activeDateKey,
        isRestDay: false,
        category: "RÉCUPÉRATION ACTIVE",
        title: "30 min Footing Souple Régénérant (Adapté IA)",
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
        title: "Mobilité douce & Prévention Sans Impact (Adapté IA)",
        duration: "20 min",
        distance: "0 km",
        targetPace: "—",
        targetZoneLabel: "Zone 1",
        targetZoneBpm: "< 115 bpm",
        aiAdjustmentNote:
          "Course suspendue aujourd'hui et fin de semaine assouplie pour protéger tes muscles.",
        tags: ["20 min", "Sans impact", "Prévention"],
      });
    } else if (mode === "postpone") {
      result.push({
        dateKey: activeDateKey,
        isRestDay: true,
        category: "RÉCUPÉRATION PASSIVE",
        title: "Repos / Imprévu (Séance reportée par l'IA)",
        duration: "—",
        distance: "0 km",
        targetPace: "—",
        targetZoneLabel: "Zone 1",
        targetZoneBpm: "< 110 bpm",
        aiAdjustmentNote:
          "Repos placé aujourd'hui suite à ton imprévu, reste de la semaine rééquilibré.",
        tags: ["Repos adapté", "Zéro culpabilité"],
      });
    }

    // Rééquilibrage automatique des jours suivants de la semaine (sans toucher aux séances DONE ni aux LifeRules)
    const weekWorkouts = athleteContext.currentWeekWorkouts || [];
    for (const w of weekWorkouts) {
      if (w.dateKey <= activeDateKey || w.status === "done" || w.status === "DONE") {
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
          title: `${w.title.replace(/\s*\(Rééquilibré IA\)/g, "")} (Rééquilibré IA)`,
          duration: w.duration === "1h30" ? "1h10" : "45 min",
          distance: w.distance === "16,0 km" ? "12,0 km" : "8,0 km",
          targetPace: easySinglePace,
          targetZoneLabel: "Zone 2",
          targetZoneBpm: "135–148 bpm",
          aiAdjustmentNote:
            "Charge automatiquement lissée par l'IA pour respecter ton état de forme de la semaine.",
          tags: ["Rééquilibré IA", `Allure : ${easySinglePace}`, "Zone 2"],
        });
        break;
      } else if (mode === "postpone") {
        // Report de la qualité sur le prochain jour disponible non verrouillé
        result.push({
          dateKey: w.dateKey,
          isRestDay: false,
          category: "SÉANCE QUALITATIVE",
          title: `${athleteContext.activeWorkout?.title || "Séance Seuil"} (Reportée IA)`,
          duration: athleteContext.activeWorkout?.duration || "1h05",
          distance: athleteContext.activeWorkout?.distance || "12,0 km",
          targetPace: paces.thresholdPaceZ4,
          targetZoneLabel: "Zone 3–4",
          targetZoneBpm: "158–172 bpm",
          aiAdjustmentNote:
            "Séance clé automatiquement reportée ici en respectant tes jours sanctuarisés.",
          tags: ["Report IA", `Seuil : ${paces.thresholdPaceZ4}`, "Zone 3/4"],
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
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`);
      }

      const data: any = await response.json();
      const rawContent: string =
        data?.choices?.[0]?.message?.content || "";

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

    let weeksRemaining = 12;
    const monthsMatch = lower.match(/(\d+)\s*mois/i);
    const weeksMatch = lower.match(/(\d+)\s*semaine/i);
    if (weeksMatch) {
      weeksRemaining = parseInt(weeksMatch[1], 10);
    } else if (monthsMatch) {
      weeksRemaining = parseInt(monthsMatch[1], 10) * 4;
    }

    return {
      title,
      target,
      raceDate: `Dans ${weeksRemaining} semaines`,
      weeksRemaining,
      distanceKm,
    };
  }
}
