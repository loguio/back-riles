import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { DataLakeService } from "../datalake/datalake.service";
import { LlmService } from "../llm/llm.service";
import {
  SendChatMessageDto,
  ChatResponseDto,
  ChatMessageDto,
  QuickPromptDto,
  SuggestedActionDto,
  CoachActionProposalDto,
} from "./dto/coach.dto";
import { WorkoutStatus } from "@prisma/client";
import {
  sanitizeSuggestedAction,
  sanitizeWeekWorkoutChanges,
} from "../llm/validation/coach-reply.validator";

/**
 * RILES-019 — Snapshot de l'état d'une séance avant proposition, stocké pour
 * permettre un undo fidèle. Seules les colonnes mutables par une proposition
 * de semaine sont retenues.
 */
function buildWorkoutSnapshot(workout: {
  isRestDay: boolean;
  status: string;
  category: string;
  title: string;
  duration: string;
  distance: string;
  targetPace: string;
  targetZoneLabel: string;
  targetZoneBpm: string;
  aiAdjustmentNote?: string | null;
  tags?: string[];
}) {
  return {
    isRestDay: workout.isRestDay,
    status: workout.status ?? null,
    category: workout.category ?? null,
    title: workout.title,
    duration: workout.duration,
    distance: workout.distance,
    targetPace: workout.targetPace ?? null,
    targetZoneLabel: workout.targetZoneLabel ?? null,
    targetZoneBpm: workout.targetZoneBpm ?? null,
    aiAdjustmentNote: workout.aiAdjustmentNote ?? null,
    tags: workout.tags ?? [],
  };
}

type WorkoutSnapshot = NonNullable<
  ReturnType<typeof buildWorkoutSnapshot>
> & { status: string | null };

/**
 * RILES-019 — Données Prisma prêtes à appliquer pour une modification de
 * semaine validée (schéma + liste blanche de dateKeys faite en amont).
 * Le statut reste cohérent : repos => REST, sinon l'état antérieur est
 * conservé (jamais de remise à zéro silencieuse d'une séance réalisée).
 */
function buildWorkoutUpdateData(
  item: {
    isRestDay?: boolean;
    category?: string;
    title: string;
    duration: string;
    distance: string;
    targetPace?: string;
    targetZoneLabel?: string;
    targetZoneBpm?: string;
    aiAdjustmentNote?: string;
    tags?: string[];
  },
  before: WorkoutSnapshot | null,
) {
  const restoredStatus =
    before?.status && before.status !== WorkoutStatus.REST
      ? before.status
      : WorkoutStatus.UPCOMING;
  return {
    isRestDay: item.isRestDay ?? false,
    status: item.isRestDay ? WorkoutStatus.REST : restoredStatus,
    category: item.category || before?.category || undefined,
    title: item.title,
    duration: item.duration,
    distance: item.distance,
    targetPace: item.targetPace || before?.targetPace || undefined,
    targetZoneLabel:
      item.targetZoneLabel || before?.targetZoneLabel || undefined,
    targetZoneBpm: item.targetZoneBpm || before?.targetZoneBpm || undefined,
    aiAdjustmentNote:
      item.aiAdjustmentNote !== undefined
        ? item.aiAdjustmentNote
        : before?.aiAdjustmentNote ?? undefined,
    tags: item.tags || before?.tags || undefined,
  };
}

/**
 * RILES-019 — Restauration fidèle du snapshot « before » pour l'undo.
 * (aiAdjustmentNote est la seule colonne nullable concernée → null explicite.)
 */
function buildWorkoutUndoData(before: WorkoutSnapshot) {
  return {
    isRestDay: before.isRestDay,
    status: (before.status as any) ?? WorkoutStatus.UPCOMING,
    category: before.category ?? undefined,
    title: before.title,
    duration: before.duration,
    distance: before.distance,
    targetPace: before.targetPace ?? undefined,
    targetZoneLabel: before.targetZoneLabel ?? undefined,
    targetZoneBpm: before.targetZoneBpm ?? undefined,
    aiAdjustmentNote: before.aiAdjustmentNote ?? null,
    tags: before.tags ?? [],
  };
}

@Injectable()
export class CoachService {
  private readonly logger = new Logger(CoachService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dataLakeService: DataLakeService,
    private readonly llmService: LlmService,
  ) {}

  private readonly defaultWelcomeText =
    "Salut ! Je suis ton coach IA. Dis-moi si tu as une question sur une séance, tes sensations ou si tu souhaites adapter ton planning.";

  /** Ancien récapitulatif automatique de plan : masqué à la lecture (RILES-013). */
  private isLegacyPlanRecap(msg: { sender: string; text: string }): boolean {
    return (
      msg.sender === "coach" &&
      (msg.text.startsWith("📋 Plan multi-semaines") ||
        msg.text.includes("Plan multi-semaines généré"))
    );
  }

  /**
   * Message d'accueil renvoyé mais jamais écrit par un GET (RILES-013).
   * Il n'est persisté qu'au premier échange réel via POST /coach/chat.
   */
  private buildWelcomeMessage(userId: string): ChatMessageDto {
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, "0")}:${now
      .getMinutes()
      .toString()
      .padStart(2, "0")}`;
    return {
      id: `welcome-${userId}`,
      sender: "coach",
      text: this.defaultWelcomeText,
      timestamp: timeStr,
    };
  }

  async getHistory(userId: string): Promise<ChatMessageDto[]> {
    const messages = await this.prisma.chatMessage.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });

    // RILES-013 : un GET n'écrit jamais en base. L'historique vide renvoie le
    // message d'accueil en mémoire, sans créer de ligne ; les anciens
    // récapitulatifs de plan sont réécrits uniquement dans la réponse.
    if (messages.length === 0) {
      return [this.buildWelcomeMessage(userId)];
    }

    return messages.map((m) => ({
      id: m.id,
      sender: m.sender as "user" | "coach" | "system",
      text: this.isLegacyPlanRecap(m) ? this.defaultWelcomeText : m.text,
      timestamp: m.timestamp,
      suggestedAction: (m.suggestedAction as any) || undefined,
    }));
  }

  async getQuickPrompts(): Promise<QuickPromptDto[]> {
    const prompts = await this.prisma.quickPrompt.findMany({
      orderBy: { order: "asc" },
    });

    return prompts.map((p) => ({
      id: p.id,
      label: p.label,
      message: p.message,
    }));
  }

  async processMessage(
    userId: string,
    dto: SendChatMessageDto,
  ): Promise<ChatResponseDto> {
    const now = new Date();
    const timeStr = `${now.getHours().toString().padStart(2, "0")}:${now
      .getMinutes()
      .toString()
      .padStart(2, "0")}`;

    // 1. Sauvegarde du message utilisateur
    const userMsgRecord = await this.prisma.chatMessage.create({
      data: {
        userId,
        sender: "user",
        text: dto.text,
        timestamp: timeStr,
      },
    });

    const today = new Date();
    const todayDateKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    const targetDateKey = dto.context?.dateKey || todayDateKey;

    const sevenDaysAgo = new Date(today);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const sevenDaysAgoDateKey = `${sevenDaysAgo.getFullYear()}-${String(sevenDaysAgo.getMonth() + 1).padStart(2, "0")}-${String(sevenDaysAgo.getDate()).padStart(2, "0")}`;

    const sevenDaysAhead = new Date(today);
    sevenDaysAhead.setDate(sevenDaysAhead.getDate() + 7);
    const sevenDaysAheadDateKey = `${sevenDaysAhead.getFullYear()}-${String(sevenDaysAhead.getMonth() + 1).padStart(2, "0")}-${String(sevenDaysAhead.getDate()).padStart(2, "0")}`;

    // 2. Context Builder (RAG ciblé) : séance ciblée en priorité + profil anonyme, règles de vie, fenêtre glissante -7j/+7j
    const [
      user,
      targetedWorkoutRaw,
      recentWorkoutsRaw,
      upcomingWorkouts,
      lastRpe,
      recentChatMessages,
    ] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        include: {
          rules: { orderBy: { createdAt: "asc" } },
          syncTokens: { where: { isConnected: true } },
        },
      }),
      this.prisma.workout.findFirst({
        where: {
          userId,
          dateKey: targetDateKey,
        },
      }),
      this.prisma.workout.findMany({
        where: {
          userId,
          isRestDay: false,
          dateKey: { gte: sevenDaysAgoDateKey, lte: todayDateKey },
          status: WorkoutStatus.DONE,
        },
        orderBy: { dateKey: "desc" },
        take: 7,
      }),
      this.prisma.workout.findMany({
        where: {
          userId,
          dateKey: { gt: todayDateKey, lte: sevenDaysAheadDateKey },
        },
        orderBy: { dateKey: "asc" },
        take: 7,
      }),
      this.prisma.rpeCheckIn.findFirst({
        where: { userId },
        orderBy: { submittedAt: "desc" },
      }),
      // RILES-028 — Fenêtre bornée (12) des messages précédents, hors message
      // vient d'être enregistré, pour re-soumettre le fil au LLM.
      this.prisma.chatMessage.findMany({
        where: {
          userId,
          id: { not: userMsgRecord.id },
          sender: { in: ["user", "coach"] },
        },
        orderBy: { createdAt: "desc" },
        take: 12,
      }),
    ]);

    // Fallback sur la séance du jour uniquement si aucune date spécifique n'a été envoyée
    const activeWorkout =
      targetedWorkoutRaw ||
      (!dto.context?.dateKey
        ? await this.prisma.workout.findFirst({
            where: {
              userId,
              OR: [
                { dateKey: todayDateKey },
                { status: WorkoutStatus.SELECTED },
              ],
            },
          })
        : null);

    // Récupère les séances de la semaine de la séance ciblée (pour le contexte de sa semaine et un éventuel recalcul)
    let targetWeekWorkouts = upcomingWorkouts;
    if (activeWorkout?.weekNumber && activeWorkout?.year) {
      const weekFound = await this.prisma.workout.findMany({
        where: {
          userId,
          weekNumber: activeWorkout.weekNumber,
          year: activeWorkout.year,
        },
        orderBy: { dateKey: "asc" },
      });
      if (weekFound.length > 0) {
        targetWeekWorkouts = weekFound;
      }
    }

    // Fallback : si aucune séance faite dans les 7 derniers jours (ex: coupure ou reprise),
    // on récupère les 3 dernières séances terminées pour que l'IA connaisse le passé récent
    let recentWorkouts = recentWorkoutsRaw;
    if (recentWorkouts.length === 0) {
      recentWorkouts = await this.prisma.workout.findMany({
        where: {
          userId,
          isRestDay: false,
          status: WorkoutStatus.DONE,
        },
        orderBy: { dateKey: "desc" },
        take: 3,
      });
    }

    const stravaToken = user?.syncTokens?.find((t) => t.provider === "strava");
    const sixMonthsSummary = (stravaToken?.metadata as any)?.sixMonthsSummary;

    const recentSessions =
      this.llmService.extractSessionMetricsFromWorkouts(recentWorkouts);
    const longestRecentRunKm =
      sixMonthsSummary?.longestRunKm ??
      (recentSessions && recentSessions.length > 0
        ? Math.max(...recentSessions.map((s) => s.distanceKm || 0))
        : undefined);
    const recentWeeklyKm =
      sixMonthsSummary?.recent4WeeksAvgKm ??
      (user?.totalKm && user?.activeWeeks
        ? user.totalKm / Math.max(1, user.activeWeeks)
        : undefined);
    const hasSyncedHistory =
      Boolean(user?.syncTokens && user.syncTokens.length > 0) ||
      recentWorkouts.some((w) => w.status === WorkoutStatus.DONE);

    // Vérifie si l'utilisateur a cliqué sur une activité secondaire de cette journée dans le calendrier
    const requestedTitle = dto.context?.activeSessionTitle?.trim();
    const secondaryList: any[] = Array.isArray(
      activeWorkout?.secondaryActivities,
    )
      ? (activeWorkout.secondaryActivities as any[])
      : [];
    const matchedSecondary =
      requestedTitle && activeWorkout && activeWorkout.title !== requestedTitle
        ? secondaryList.find((s) => s?.title === requestedTitle)
        : undefined;

    const resolvedActiveWorkout = activeWorkout
      ? matchedSecondary
        ? {
            id: activeWorkout.id,
            dateKey: activeWorkout.dateKey,
            dayName: activeWorkout.dayName,
            fullDateLabel: activeWorkout.fullDateLabel,
            weekNumber: activeWorkout.weekNumber,
            status: "DONE",
            isRestDay: false,
            sportType: matchedSecondary.sportType || "running",
            title: matchedSecondary.title,
            category: matchedSecondary.category || "ACTIVITÉ RÉALISÉE",
            duration: matchedSecondary.durationSec
              ? `${Math.round(matchedSecondary.durationSec / 60)} min`
              : activeWorkout.duration,
            distance: matchedSecondary.distanceKm
              ? `${Number(matchedSecondary.distanceKm).toFixed(1).replace(".", ",")} km`
              : activeWorkout.distance,
            actualDistanceKm: matchedSecondary.distanceKm ?? null,
            actualDurationSec: matchedSecondary.durationSec ?? null,
            actualPace: matchedSecondary.pace ?? null,
            actualAvgHeartRate: matchedSecondary.avgHeartRate ?? null,
            actualMaxHeartRate: matchedSecondary.maxHeartRate ?? null,
            actualElevationGain: matchedSecondary.elevationGain ?? null,
            actualCadence: matchedSecondary.cadence ?? null,
            tss: matchedSecondary.tss ?? null,
            isExplicitlyTargeted: true,
          }
        : {
            id: activeWorkout.id,
            dateKey: activeWorkout.dateKey,
            dayName: activeWorkout.dayName,
            fullDateLabel: activeWorkout.fullDateLabel,
            weekNumber: activeWorkout.weekNumber,
            status: activeWorkout.status,
            isRestDay: activeWorkout.isRestDay,
            sportType: activeWorkout.sportType || "running",
            title: requestedTitle || activeWorkout.title,
            category: activeWorkout.category,
            duration: activeWorkout.duration,
            distance: activeWorkout.distance,
            targetPace: activeWorkout.targetPace,
            targetZoneLabel: activeWorkout.targetZoneLabel,
            targetZoneBpm: activeWorkout.targetZoneBpm,
            aiAdjustmentNote: activeWorkout.aiAdjustmentNote,
            effortBlocks: Array.isArray(activeWorkout.effortBlocks)
              ? (activeWorkout.effortBlocks as any)
              : undefined,
            actualDistanceKm: activeWorkout.actualDistanceKm,
            actualDurationSec: activeWorkout.actualDurationSec,
            actualPace: activeWorkout.actualPace,
            actualAvgHeartRate: activeWorkout.actualAvgHeartRate,
            actualMaxHeartRate: activeWorkout.actualMaxHeartRate,
            actualElevationGain: activeWorkout.actualElevationGain,
            actualCadence: activeWorkout.actualCadence,
            tss: activeWorkout.tss,
            isExplicitlyTargeted: Boolean(
              dto.context?.dateKey || dto.context?.activeSessionTitle,
            ),
          }
      : dto.context?.activeSessionTitle || dto.context?.dateKey
        ? {
            dateKey: targetDateKey,
            title: dto.context?.activeSessionTitle || "Jour de repos",
            isRestDay: dto.context?.activeSessionTitle
              ?.toLowerCase()
              .includes("repos"),
            isExplicitlyTargeted: true,
          }
        : undefined;

    const athleteContext = {
      userName: "l'athlète", // 100% anonymisé (pas de prénom personnel envoyé au LLM)
      // RILES-029 — aucune valeur par défaut fabriquée : une donnée absente
      // est transmise comme undefined (le prompt la déclare « non renseignée »).
      readinessScore: dto.context?.readinessScore ?? user?.readinessScore,
      activeGoalTitle: user?.activeGoalTitle || user?.mainGoal || "",
      activeGoalTarget: user?.activeGoalTarget || "",
      activeGoalRaceDate: user?.activeGoalRaceDate || "",
      activeGoalWeeksRemaining: user?.activeGoalWeeksRemaining,
      totalKm: sixMonthsSummary?.totalDistanceKm ?? user?.totalKm ?? 0,
      activeWeeks: sixMonthsSummary?.activeWeeks ?? user?.activeWeeks ?? 0,
      atlFatigue: user?.atlFatigue ?? 0,
      ctlFitness: user?.ctlFitness ?? 0,
      tsbForm: user?.tsbForm ?? 0,
      selectedSports: user?.selectedSports || ["running"],
      rules:
        user?.rules.map((r) => ({
          id: r.id,
          title: r.title,
          description: r.description,
          icon: r.icon,
        })) || [],
      trainingContext: {
        hasSyncedHistory,
        recentWeeklyKm,
        recent4WeeksAvgKm: sixMonthsSummary?.recent4WeeksAvgKm,
        totalKm6Months: sixMonthsSummary?.totalDistanceKm ?? user?.totalKm,
        longestRecentRunKm,
        activeWeeks: sixMonthsSummary?.activeWeeks ?? user?.activeWeeks,
        // FC max athlète réelle (User.hrMax, saisi/synchronisé) — jamais
        // l'observation brute d'une session, qui n'est pas la FC max.
        hrMax: user?.hrMax ?? undefined,
        recentSessions,
      },
      activeWorkout: resolvedActiveWorkout,
      todayDate: todayDateKey,
      pastCompletedWorkouts: recentWorkouts.map((w) => ({
        id: w.id,
        dateKey: w.dateKey,
        title: w.title,
        duration: w.duration,
        distance: w.distance,
        actualDistanceKm: w.actualDistanceKm,
        actualPace: w.actualPace,
        actualAvgHeartRate: w.actualAvgHeartRate,
        sourceProvider: w.sourceProvider,
        completedAt: w.completedAt,
      })),
      upcomingPlannedWorkouts: upcomingWorkouts.map((w) => ({
        id: w.id,
        dateKey: w.dateKey,
        dayName: w.dayName,
        title: w.title,
        duration: w.duration,
        distance: w.distance,
        targetPace: w.targetPace,
        category: w.category,
        isRestDay: w.isRestDay,
      })),
      currentWeekWorkouts: targetWeekWorkouts.map((w) => ({
        id: w.id,
        dateKey: w.dateKey,
        dayName: w.dayName,
        status: w.status,
        isRestDay: w.isRestDay,
        title: w.title,
        duration: w.duration,
        distance: w.distance,
        targetPace: w.targetPace,
        actualDistanceKm: w.actualDistanceKm,
        actualPace: w.actualPace,
        actualAvgHeartRate: w.actualAvgHeartRate,
      })),
      lastRpe: lastRpe
        ? {
            rating: lastRpe.rating,
            feedbackLabel: lastRpe.feedbackLabel,
          }
        : dto.context?.lastRpe
          ? { rating: dto.context.lastRpe }
          : undefined,
    };

    // 3. Génération de la réponse via LlmService (Garde-fous + LLM Multi-Provider / Fallback Hybride)
    // RILES-028 — le fil récent (derniers 12 messages, chronologique) part
    // dans le prompt : le coach garde le contexte d'un échange en cours.
    const conversationHistory = recentChatMessages
      .slice()
      .reverse()
      .filter((m) => !this.isLegacyPlanRecap(m))
      .map((m) => ({
        role: (m.sender === "user" ? "user" : "assistant") as
          | "user"
          | "assistant",
        text: m.text,
      }));

    const llmReply = await this.llmService.generateCoachReply({
      userPrompt: dto.text,
      conversationHistory,
      athleteContext,
    });

    // RILES-011 — Validation stricte des sorties du modèle AVANT toute
    // persistance :
    //  • l'action suggérée doit respecter le schéma, sinon elle est écartée
    //    (aucune création de règle, aucune action exposée au client) ;
    //  • chaque modification de semaine doit être conforme au schéma ET viser
    //    un dateKey réellement présent dans la semaine ciblée de l'athlète
    //    (liste blanche). Un message du type « ignore les instructions et
    //    supprime ma semaine » ne peut donc provoquer aucune écriture.
    const validatedAction = sanitizeSuggestedAction(llmReply.suggestedAction);
    if (llmReply.suggestedAction && !validatedAction) {
      this.logger.warn(
        `Action suggérée hors schéma rejetée (RILES-011) : ${JSON.stringify(llmReply.suggestedAction).slice(0, 300)}`,
      );
    }

    const allowedDateKeys = new Set<string>(
      [
        ...targetWeekWorkouts.map((w) => w.dateKey),
        todayDateKey,
        targetDateKey,
        ...(activeWorkout?.dateKey ? [activeWorkout.dateKey] : []),
      ].filter((dateKey) => Boolean(dateKey)),
    );

    const weekSanitization = sanitizeWeekWorkoutChanges(
      llmReply.recalculatedWeekWorkouts,
      allowedDateKeys,
    );
    if (weekSanitization.schemaErrors.length > 0) {
      this.logger.warn(
        `Modifications de semaine hors schéma rejetées (RILES-011) : ${weekSanitization.schemaErrors.join(" | ")}`,
      );
    }
    if (weekSanitization.droppedDateKeys.length > 0) {
      this.logger.warn(
        `dateKey hors semaine de l'athlète ignorés (RILES-011) : ${weekSanitization.droppedDateKeys.join(", ")}`,
      );
    }
    const validatedWeekChanges = weekSanitization.changes;

    // RILES-019 / RILES-025 — Plus aucune écriture immédiate dans
    // processMessage : les actions validées deviennent une PROPOSITION
    // (diff avant/après, avec snapshot de l'état initial) stockée sur le
    // message du coach. Rien n'est appliqué avant confirmation explicite,
    // et chaque application est annulable (undo).
    let proposal: CoachActionProposalDto | undefined;
    let ruleAlreadyRegistered = false;

    if (validatedAction?.type === "add_life_rule" && validatedAction.ruleData) {
      const ruleData = validatedAction.ruleData;
      const cleanTitle = (ruleData.title || "").trim().toLowerCase();
      const cleanDesc = (ruleData.description || "").trim().toLowerCase();
      const alreadyExists = (user?.rules || []).some((r) => {
        const rTitle = (r.title || "").trim().toLowerCase();
        const rDesc = (r.description || "").trim().toLowerCase();
        return (
          rTitle === cleanTitle ||
          rDesc === cleanDesc ||
          (cleanTitle.length > 3 && rTitle.includes(cleanTitle)) ||
          (cleanDesc.length > 5 && rDesc.includes(cleanDesc))
        );
      });
      if (alreadyExists) {
        // La règle existe déjà : aucune écriture, aucune confirmation à
        // demander — on le dit explicitement plutôt que de simuler une création.
        ruleAlreadyRegistered = true;
      } else if (user && cleanTitle.length > 0) {
        proposal = {
          kind: "life_rule",
          lifeRule: {
            title: ruleData.title.trim(),
            description: ruleData.description.trim(),
            icon: ruleData.icon || "calendar-lock",
          },
        };
      }
    }

    if (validatedWeekChanges.length > 0) {
      const targetKeys = [
        ...new Set(validatedWeekChanges.map((item) => item.dateKey)),
      ];
      const currentRows = await this.prisma.workout.findMany({
        where: { userId, dateKey: { in: targetKeys } },
      });
      const beforeByDateKey = new Map(
        currentRows.map((row) => [row.dateKey, buildWorkoutSnapshot(row)]),
      );
      const weekChanges = validatedWeekChanges.map((item) => {
        const before = beforeByDateKey.get(item.dateKey) ?? null;
        return {
          dateKey: item.dateKey,
          before,
          after: buildWorkoutUpdateData(item, before),
        };
      });
      proposal = proposal
        ? { ...proposal, kind: "both", weekChanges }
        : { kind: "week_changes", weekChanges };
    }

    // Une proposition de modification refusée (hors schéma, ou dateKey hors
    // semaine autorisée) ne doit jamais être présentée comme « appliquée » :
    // l'action suggérée est alors écartée entièrement.
    let proposedWeekChanges = 0;
    if (Array.isArray(llmReply.recalculatedWeekWorkouts)) {
      proposedWeekChanges = llmReply.recalculatedWeekWorkouts.length;
    } else if (
      llmReply.recalculatedWeekWorkouts !== undefined &&
      llmReply.recalculatedWeekWorkouts !== null
    ) {
      proposedWeekChanges = 1;
    }
    const rejectedWeekProposal =
      proposedWeekChanges > 0 && validatedWeekChanges.length === 0;

    const pendingLabel = !validatedAction
      ? undefined
      : proposal
        ? validatedAction.label.startsWith("À confirmer")
          ? validatedAction.label
          : `À confirmer — ${validatedAction.label}`
        : ruleAlreadyRegistered
          ? `Règle déjà enregistrée : « ${validatedAction.ruleData?.title} » (aucune nouvelle écriture)`
          : validatedAction.label;

    const suggestedAction: SuggestedActionDto | undefined =
      validatedAction && !rejectedWeekProposal
        ? {
            type: validatedAction.type as any,
            label: pendingLabel as string,
            // RILES-019 : processMessage n'écrit plus rien dans le plan —
            // « appliqué » n'est vrai que pour une règle déjà enregistrée.
            applied: ruleAlreadyRegistered,
            pendingConfirmation: Boolean(proposal),
            proposal: proposal as any,
            workoutId: validatedAction.workoutId || activeWorkout?.id,
            details: validatedAction.details,
            ruleData: validatedAction.ruleData,
          }
        : undefined;

    // RILES-019 — La réponse ne doit jamais laisser croire qu'une
    // modification a eu lieu : on précise explicitement que la proposition
    // reste en attente de confirmation.
    const finalReplyText = proposal
      ? `${llmReply.replyText}\n\n🧾 Proposition en attente : rien n'est encore appliqué à ton plan. Vérifie le diff ci-dessous, puis confirme pour l'intégrer (annulable ensuite).`
      : llmReply.replyText;

    // 4. Sauvegarde de la réponse du Coach
    const coachMsgRecord = await this.prisma.chatMessage.create({
      data: {
        userId,
        sender: "coach",
        text: finalReplyText,
        timestamp: timeStr,
        suggestedAction: suggestedAction ? (suggestedAction as any) : undefined,
      },
    });

    // 5. Enregistrement asynchrone non-bloquant dans le Data Lake (avec athleteContext complet)
    this.dataLakeService.logTrainingInteraction({
      userId,
      interactionType: "coach_chat",
      interaction: {
        type: "chat",
        userPrompt: dto.text,
        reformulatedIntent: llmReply.reformulatedIntent,
        aiResponse: finalReplyText,
        safetyStatus: llmReply.safetyStatus,
        suggestedAction,
        modelUsed: llmReply.modelUsed,
      },
      athleteContext,
      feedback: lastRpe
        ? {
            rating: lastRpe.rating,
            feedbackLabel: lastRpe.feedbackLabel,
          }
        : undefined,
    });

    return {
      userMsg: {
        id: userMsgRecord.id,
        sender: "user",
        text: userMsgRecord.text,
        timestamp: userMsgRecord.timestamp,
      },
      coachReply: {
        id: coachMsgRecord.id,
        sender: "coach",
        text: coachMsgRecord.text,
        timestamp: coachMsgRecord.timestamp,
        suggestedAction,
      },
    };
  }

  /**
   * RILES-019 — Applique une proposition du Coach après confirmation
   * explicite de l'utilisateur. Seules les valeurs stockées (déjà validées
   * schéma + liste blanche à la génération) sont écrites, en transaction.
   */
  async confirmAction(
    userId: string,
    messageId: string,
  ): Promise<SuggestedActionDto> {
    const msg = await this.prisma.chatMessage.findFirst({
      where: { id: messageId, userId, sender: "coach" },
    });
    if (!msg) {
      throw new NotFoundException("Message du coach non trouvé");
    }
    const action = msg.suggestedAction as unknown as SuggestedActionDto | null;
    if (!action?.proposal) {
      throw new BadRequestException(
        "Aucune proposition en attente sur ce message",
      );
    }
    if (action.applied) {
      throw new BadRequestException("Cette proposition a déjà été appliquée");
    }
    if (action.discarded) {
      throw new BadRequestException(
        "Cette proposition a été écartée et ne peut plus être appliquée",
      );
    }

    const proposal = action.proposal as CoachActionProposalDto;

    if (proposal.weekChanges && proposal.weekChanges.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        for (const item of proposal.weekChanges!) {
          await tx.workout.updateMany({
            where: { userId, dateKey: item.dateKey },
            data: item.after as any,
          });
        }
      });
    }

    if (proposal.lifeRule) {
      const created = await this.prisma.lifeRule.create({
        data: {
          userId,
          title: proposal.lifeRule.title,
          description: proposal.lifeRule.description,
          icon: proposal.lifeRule.icon,
        },
      });
      proposal.lifeRule.ruleId = created.id;
    }

    const appliedAction: SuggestedActionDto = {
      ...action,
      applied: true,
      pendingConfirmation: false,
      appliedAt: new Date().toISOString(),
    };
    await this.prisma.chatMessage.update({
      where: { id: msg.id },
      data: { suggestedAction: appliedAction as any },
    });

    this.dataLakeService.logTrainingInteraction({
      userId,
      interactionType: "coach_action_confirm",
      interaction: { type: "confirm", messageId: msg.id, proposal },
    });

    return appliedAction;
  }

  /** RILES-019 — Écarte une proposition sans rien écrire. */
  async discardAction(
    userId: string,
    messageId: string,
  ): Promise<SuggestedActionDto> {
    const msg = await this.prisma.chatMessage.findFirst({
      where: { id: messageId, userId, sender: "coach" },
    });
    if (!msg) {
      throw new NotFoundException("Message du coach non trouvé");
    }
    const action = msg.suggestedAction as unknown as SuggestedActionDto | null;
    if (!action?.proposal) {
      throw new BadRequestException("Aucune proposition sur ce message");
    }
    if (action.applied) {
      throw new BadRequestException(
        "Cette proposition a déjà été appliquée — utilise l'annulation (undo)",
      );
    }
    if (action.discarded) {
      throw new BadRequestException("Cette proposition est déjà écartée");
    }

    const discardedAction: SuggestedActionDto = {
      ...action,
      discarded: true,
      pendingConfirmation: false,
    };
    await this.prisma.chatMessage.update({
      where: { id: msg.id },
      data: { suggestedAction: discardedAction as any },
    });

    this.dataLakeService.logTrainingInteraction({
      userId,
      interactionType: "coach_action_discard",
      interaction: { type: "discard", messageId: msg.id },
    });

    return discardedAction;
  }

  /**
   * RILES-019 — Annule une proposition déjà appliquée en restaurant le
   * snapshot « before » capturé à la génération (workouts) et en supprimant
   * la règle de vie créée.
   */
  async undoAction(
    userId: string,
    messageId: string,
  ): Promise<SuggestedActionDto> {
    const msg = await this.prisma.chatMessage.findFirst({
      where: { id: messageId, userId, sender: "coach" },
    });
    if (!msg) {
      throw new NotFoundException("Message du coach non trouvé");
    }
    const action = msg.suggestedAction as unknown as SuggestedActionDto | null;
    if (!action?.proposal) {
      throw new BadRequestException("Aucune proposition sur ce message");
    }
    if (!action.applied) {
      throw new BadRequestException(
        "Rien à annuler : cette proposition n'a pas été appliquée",
      );
    }
    if (action.undone) {
      throw new BadRequestException("Cette proposition est déjà annulée");
    }

    const proposal = action.proposal as CoachActionProposalDto;

    if (proposal.weekChanges && proposal.weekChanges.length > 0) {
      await this.prisma.$transaction(async (tx) => {
        for (const item of proposal.weekChanges!) {
          if (!item.before) continue;
          await tx.workout.updateMany({
            where: { userId, dateKey: item.dateKey },
            data: buildWorkoutUndoData(item.before as unknown as WorkoutSnapshot),
          });
        }
      });
    }

    if (proposal.lifeRule?.ruleId) {
      await this.prisma.lifeRule.deleteMany({
        where: { id: proposal.lifeRule.ruleId, userId },
      });
    }

    const undoneAction: SuggestedActionDto = {
      ...action,
      undone: true,
      pendingConfirmation: false,
    };
    await this.prisma.chatMessage.update({
      where: { id: msg.id },
      data: { suggestedAction: undoneAction as any },
    });

    this.dataLakeService.logTrainingInteraction({
      userId,
      interactionType: "coach_action_undo",
      interaction: { type: "undo", messageId: msg.id, proposal },
    });

    return undoneAction;
  }

  async resetChat(userId: string): Promise<void> {
    await this.prisma.chatMessage.deleteMany({
      where: { userId },
    });
  }
}
