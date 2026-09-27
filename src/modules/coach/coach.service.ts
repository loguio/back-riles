import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { DataLakeService } from "../datalake/datalake.service";
import {
  SendChatMessageDto,
  ChatResponseDto,
  ChatMessageDto,
  QuickPromptDto,
  SuggestedActionDto,
} from "./dto/coach.dto";

@Injectable()
export class CoachService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly dataLakeService: DataLakeService,
  ) {}

  async getHistory(userId: string): Promise<ChatMessageDto[]> {
    const messages = await this.prisma.chatMessage.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });

    return messages.map((m) => ({
      id: m.id,
      sender: m.sender as "user" | "coach" | "system",
      text: m.text,
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

    // 1. Save user message
    const userMsgRecord = await this.prisma.chatMessage.create({
      data: {
        userId,
        sender: "user",
        text: dto.text,
        timestamp: timeStr,
      },
    });

    // 2. Intelligent Contextual Coach Reply Analysis
    const lowerText = dto.text.toLowerCase();
    let replyText =
      "Bien reçu ! J'ai réajusté ta charge d'entraînement pour garantir ta progression sans fatigue excessive.";
    let suggestedAction: SuggestedActionDto | undefined = undefined;

    if (lowerText.includes("fatigué") || lowerText.includes("fatigue")) {
      replyText =
        "C'est noté Marius. Quand le corps est fatigué, insister sur du seuil augmente le risque de blessure et le temps de récupération. Je te propose d'alléger la séance de ce soir en un footing doux de 35 min en Zone 2.";
      suggestedAction = {
        type: "reduce_intensity",
        label: "Appliquer : Alléger la séance à 35 min",
        applied: false,
        details: "lighten",
      };
    } else if (
      lowerText.includes("décaler") ||
      lowerText.includes("imprévu") ||
      lowerText.includes("demain")
    ) {
      replyText =
        "Pas de problème, l'entraînement s'adapte à ta vie et non l'inverse. Je bascule la séance qualitative sur demain et je place ton repos aujourd'hui.";
      suggestedAction = {
        type: "reschedule",
        label: "Appliquer : Décaler le seuil à demain",
        applied: false,
        details: "postpone",
      };
    } else if (
      lowerText.includes("cool") ||
      lowerText.includes("30 min") ||
      lowerText.includes("souple")
    ) {
      replyText =
        "Excellente initiative. 30 minutes de footing régénérant en Zone 1-2 vont stimuler la récupération sans générer de fatigue résiduelle.";
      suggestedAction = {
        type: "adjust_workout",
        label: "Appliquer : Remplacer par 30 min cool",
        applied: false,
        details: "easy_run",
      };
    } else if (
      lowerText.includes("mollet") ||
      lowerText.includes("douleur") ||
      lowerText.includes("gêne") ||
      lowerText.includes("blessure")
    ) {
      replyText =
        "Prudence avant tout ! Une gêne au mollet peut vite évoluer en contracture. Je te conseille 20 min de mobilité sans impact et du glaçage ce soir. On suspend la course pour les prochaines 24h.";
      suggestedAction = {
        type: "reduce_intensity",
        label: "Appliquer : Repos mollet & Mobilité",
        applied: false,
        details: "injury_care",
      };
    } else {
      replyText =
        "J'ai bien pris en compte ta remarque. Ton plan est calibré pour ton objectif Semi-marathon sous les 2h. N'hésite pas à me signaler tout changement de sensation !";
    }

    // 3. Save Coach Message
    const coachMsgRecord = await this.prisma.chatMessage.create({
      data: {
        userId,
        sender: "coach",
        text: replyText,
        timestamp: timeStr,
        suggestedAction: suggestedAction ? (suggestedAction as any) : undefined,
      },
    });

    // 4. Enregistrement asynchrone non-bloquant dans le Data Lake
    this.dataLakeService.logTrainingInteraction({
      userId,
      interactionType: "coach_chat",
      interaction: {
        type: "chat",
        userPrompt: dto.text,
        aiResponse: replyText,
        suggestedAction,
      },
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

  async resetChat(userId: string): Promise<void> {
    await this.prisma.chatMessage.deleteMany({
      where: { userId },
    });
  }
}
