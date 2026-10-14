import "reflect-metadata";
import { CoachService } from "./coach.service";

/**
 * RILES-013 — les lectures ne doivent jamais écrire.
 *
 * `GET /coach/history` créait (et réécrivait) des messages en base :
 *  - un message d'accueil persisté dès que l'historique était vide ;
 *  - la réécriture des anciens récapitulatifs de plan dans la table
 *    `chat_messages`.
 *
 * Ces tests vérifient que la réponse est identique, mais sans aucune écriture.
 */

const USER_ID = "user-01";

function createPrismaStub(messages: Array<Record<string, unknown>>) {
  const writes: string[] = [];

  const chatMessage: any = {
    findMany: jest.fn(async () => messages),
    create: jest.fn(async (args: any) => {
      writes.push(`chatMessage.create ${JSON.stringify(args?.data ?? {})}`);
      return { id: "created-in-db", ...(args?.data ?? {}) };
    }),
    update: jest.fn(async (args: any) => {
      writes.push(`chatMessage.update ${JSON.stringify(args?.where ?? {})}`);
      return { id: args?.where?.id, ...(args?.data ?? {}) };
    }),
    updateMany: jest.fn(async () => {
      writes.push("chatMessage.updateMany");
      return { count: 0 };
    }),
    deleteMany: jest.fn(async () => {
      writes.push("chatMessage.deleteMany");
      return { count: 0 };
    }),
  };

  return { prisma: { chatMessage }, writes };
}

function createService(prisma: any): CoachService {
  const dataLakeService: any = { logTrainingInteraction: jest.fn() };
  const llmService: any = { generateCoachReply: jest.fn() };
  return new CoachService(prisma, dataLakeService, llmService);
}

describe("RILES-013 — GET /coach/history n'écrit jamais en base", () => {
  it("un historique vide renvoie le message d'accueil sans créer de ligne", async () => {
    const { prisma, writes } = createPrismaStub([]);
    const service = createService(prisma);

    const messages = await service.getHistory(USER_ID);

    expect(messages).toHaveLength(1);
    expect(messages[0].sender).toBe("coach");
    expect(messages[0].text).toContain("Je suis ton coach IA");
    // Le message d'accueil n'a pas d'id de base : il n'a jamais été écrit.
    expect(messages[0].id).toBe(`welcome-${USER_ID}`);

    expect(prisma.chatMessage.create).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("masque les anciens récapitulatifs de plan sans les réécrire", async () => {
    const { prisma, writes } = createPrismaStub([
      {
        id: "msg-1",
        sender: "coach",
        text: "📋 Plan multi-semaines (42) généré pour Marius.",
        timestamp: "18:15",
      },
      {
        id: "msg-2",
        sender: "user",
        text: "Merci !",
        timestamp: "18:20",
      },
    ]);
    const service = createService(prisma);

    const messages = await service.getHistory(USER_ID);

    expect(messages).toHaveLength(2);
    expect(messages[0].text).toContain("Je suis ton coach IA");
    expect(messages[1].text).toBe("Merci !");

    expect(prisma.chatMessage.update).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("un historique existant est renvoyé tel quel, sans écriture", async () => {
    const { prisma, writes } = createPrismaStub([
      {
        id: "msg-1",
        sender: "user",
        text: "Je suis fatigué ce soir.",
        timestamp: "20:01",
      },
      {
        id: "msg-2",
        sender: "coach",
        text: "On allège la séance de demain.",
        timestamp: "20:02",
        suggestedAction: { type: "reduce_intensity", applied: false },
      },
    ]);
    const service = createService(prisma);

    const messages = await service.getHistory(USER_ID);

    expect(messages.map((m) => m.id)).toEqual(["msg-1", "msg-2"]);
    expect(messages[1].suggestedAction).toEqual({
      type: "reduce_intensity",
      applied: false,
    });
    expect(writes).toEqual([]);
  });
});
