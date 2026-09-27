import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import {
  ConnectedAppDto,
  OnboardingStateDto,
  SaveOnboardingStepDto,
  CompleteOnboardingDto,
} from "./dto/onboarding.dto";
import { AuthProvider, PlanType } from "@prisma/client";

export const CONNECTED_APPS_CATALOG: ConnectedAppDto[] = [
  {
    id: "garmin",
    name: "Garmin",
    code: "G",
    color: "#0F172A",
    isConnected: false,
  },
  {
    id: "strava",
    name: "Strava",
    code: "S",
    color: "#FC4C02",
    isConnected: false,
  },
  {
    id: "coros",
    name: "COROS",
    code: "C",
    color: "#0F172A",
    isConnected: false,
  },
  {
    id: "polar",
    name: "Polar",
    code: "P",
    color: "#D32F2F",
    isConnected: false,
  },
  {
    id: "suunto",
    name: "Suunto",
    code: "S",
    color: "#1E293B",
    isConnected: false,
  },
  {
    id: "apple_health",
    name: "Apple Santé",
    code: "A",
    color: "#0F172A",
    isConnected: false,
  },
];

@Injectable()
export class OnboardingService {
  constructor(private readonly prisma: PrismaService) {}

  async getOnboardingState(userId: string): Promise<OnboardingStateDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        syncTokens: { where: { isConnected: true } },
      },
    });

    if (!user) {
      return {
        currentStep: 1,
        authMethod: null,
        userEmail: "",
        mainGoal: "Me préparer pour mon premier semi-marathon sans me blesser",
        selectedSports: ["running"],
        connectedApps: ["garmin"],
        selectedPlan: "pro",
        isCompleted: false,
      };
    }

    const connectedApps = user.syncTokens.map((t) => t.provider);

    return {
      currentStep: user.isOnboardingCompleted ? 5 : 1,
      authMethod:
        user.authProvider === AuthProvider.APPLE
          ? "apple"
          : user.authProvider === AuthProvider.GOOGLE
            ? "google"
            : "email",
      userEmail: user.email,
      mainGoal:
        user.mainGoal ||
        user.activeGoalTarget ||
        "Me préparer pour mon premier semi-marathon sans me blesser",
      selectedSports: user.selectedSports || ["running"],
      connectedApps:
        connectedApps.length > 0 ? connectedApps : ["garmin", "strava"],
      selectedPlan: user.planType === PlanType.PRO ? "pro" : "basic",
      isCompleted: user.isOnboardingCompleted,
    };
  }

  async getAppsCatalog(userId: string): Promise<ConnectedAppDto[]> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { syncTokens: true },
    });

    const userConnectedTokens = new Set(
      user?.syncTokens.filter((t) => t.isConnected).map((t) => t.provider) ||
        [],
    );

    return CONNECTED_APPS_CATALOG.map((app) => ({
      ...app,
      isConnected: userConnectedTokens.has(app.id),
    }));
  }

  async saveStepData(
    userId: string,
    dto: SaveOnboardingStepDto,
  ): Promise<OnboardingStateDto> {
    const dataToUpdate: any = {};
    if (dto.mainGoal) {
      dataToUpdate.mainGoal = dto.mainGoal;
      dataToUpdate.activeGoalTarget = dto.mainGoal;
    }
    if (dto.selectedSports) {
      dataToUpdate.selectedSports = dto.selectedSports;
    }
    if (dto.selectedPlan) {
      dataToUpdate.planType =
        dto.selectedPlan === "pro" ? PlanType.PRO : PlanType.BASIC;
    }
    if (dto.isCompleted !== undefined) {
      dataToUpdate.isOnboardingCompleted = dto.isCompleted;
    }

    if (dto.connectedApps) {
      for (const provider of dto.connectedApps) {
        await this.prisma.syncToken.upsert({
          where: { userId_provider: { userId, provider } },
          update: { isConnected: true },
          create: { userId, provider, isConnected: true },
        });
      }
    }

    if (Object.keys(dataToUpdate).length > 0) {
      await this.prisma.user.update({
        where: { id: userId },
        data: dataToUpdate,
      });
    }

    return this.getOnboardingState(userId);
  }

  async completeOnboarding(
    userId: string,
    dto?: CompleteOnboardingDto,
  ): Promise<OnboardingStateDto> {
    const dataToUpdate: any = {
      isOnboardingCompleted: true,
    };

    if (dto?.mainGoal) {
      dataToUpdate.mainGoal = dto.mainGoal;
      dataToUpdate.activeGoalTarget = dto.mainGoal;
    }
    if (dto?.selectedSports) {
      dataToUpdate.selectedSports = dto.selectedSports;
    }
    if (dto?.selectedPlan) {
      dataToUpdate.planType =
        dto.selectedPlan === "pro" ? PlanType.PRO : PlanType.BASIC;
    }

    if (dto?.connectedApps) {
      for (const provider of dto.connectedApps) {
        await this.prisma.syncToken.upsert({
          where: { userId_provider: { userId, provider } },
          update: { isConnected: true },
          create: { userId, provider, isConnected: true },
        });
      }
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: dataToUpdate,
    });

    return this.getOnboardingState(userId);
  }

  async resetOnboarding(userId: string): Promise<OnboardingStateDto> {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        isOnboardingCompleted: false,
      },
    });

    return this.getOnboardingState(userId);
  }
}
