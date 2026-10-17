import "reflect-metadata";
import { CommunityController } from "./community.controller";
import { CommunityService } from "./community.service";

/**
 * Phase 5B (B7) — CommunityController.
 *
 * Le contrôleur ne porte aucune logique métier : il délègue au service en
 * propageant l'identité (`@CurrentUserId`), le filtre club et le corps optionnel
 * de la bascule. Ce test verrouille ce contrat de délégation.
 */

function buildController() {
  const service: any = {
    getRuns: jest.fn(async () => []),
    toggleParticipation: jest.fn(async () => ({
      runId: "run-01",
      isJoined: true,
      participantCount: 1,
    })),
    getChallenges: jest.fn(async () => []),
  };
  const controller = new CommunityController(service as CommunityService);
  return { controller, service };
}

describe("CommunityController", () => {
  it("getRuns propage l'utilisateur courant et le filtre club", async () => {
    const { controller, service } = buildController();

    await controller.getRuns("user-01", { clubId: "club-01" });

    expect(service.getRuns).toHaveBeenCalledWith("user-01", "club-01");
  });

  it("getRuns accepte une query sans clubId", async () => {
    const { controller, service } = buildController();

    await controller.getRuns("user-01", {});

    expect(service.getRuns).toHaveBeenCalledWith("user-01", undefined);
  });

  it("toggleParticipation propage utilisateur, id et action", async () => {
    const { controller, service } = buildController();

    const result = await controller.toggleParticipation("user-01", "run-01", {
      action: "join",
    });

    expect(service.toggleParticipation).toHaveBeenCalledWith(
      "user-01",
      "run-01",
      "join",
    );
    expect(result).toEqual({
      runId: "run-01",
      isJoined: true,
      participantCount: 1,
    });
  });

  it("toggleParticipation tolère un corps absent (bascule)", async () => {
    const { controller, service } = buildController();

    await controller.toggleParticipation("user-01", "run-01", undefined as any);

    expect(service.toggleParticipation).toHaveBeenCalledWith(
      "user-01",
      "run-01",
      undefined,
    );
  });

  it("getChallenges propage l'utilisateur courant", async () => {
    const { controller, service } = buildController();

    await controller.getChallenges("user-01");

    expect(service.getChallenges).toHaveBeenCalledWith("user-01");
  });
});
