import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import {
  UserProfileDto,
  UpdateProfileDto,
  CreateUserRuleDto,
  UserRuleDto,
} from "./dto/user.dto";
import { PlanType } from "@prisma/client";

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(userId: string): Promise<UserProfileDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        rules: { orderBy: { createdAt: "asc" } },
        syncTokens: { where: { isConnected: true } },
      },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    return this.mapUserToProfileDto(user);
  }

  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
  ): Promise<UserProfileDto> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException(`User with ID ${userId} not found`);
    }

    const dataToUpdate: any = {};
    if (dto.name !== undefined) dataToUpdate.name = dto.name;
    if (dto.readinessScore !== undefined)
      dataToUpdate.readinessScore = dto.readinessScore;
    if (dto.planType !== undefined) {
      dataToUpdate.planType =
        dto.planType === "pro" ? PlanType.PRO : PlanType.BASIC;
    }

    if (dto.activeGoal) {
      if (dto.activeGoal.title !== undefined)
        dataToUpdate.activeGoalTitle = dto.activeGoal.title;
      if (dto.activeGoal.target !== undefined)
        dataToUpdate.activeGoalTarget = dto.activeGoal.target;
      if (dto.activeGoal.raceDate !== undefined)
        dataToUpdate.activeGoalRaceDate = dto.activeGoal.raceDate;
      if (dto.activeGoal.weeksRemaining !== undefined)
        dataToUpdate.activeGoalWeeksRemaining = dto.activeGoal.weeksRemaining;
      if (dto.activeGoal.progressPercentage !== undefined)
        dataToUpdate.activeGoalProgressPercentage =
          dto.activeGoal.progressPercentage;
    }

    if (dto.connectedApps) {
      // Synchronize connected app tokens
      for (const provider of dto.connectedApps) {
        await this.prisma.syncToken.upsert({
          where: {
            userId_provider: {
              userId,
              provider,
            },
          },
          update: { isConnected: true },
          create: {
            userId,
            provider,
            isConnected: true,
          },
        });
      }
    }

    const updatedUser = await this.prisma.user.update({
      where: { id: userId },
      data: dataToUpdate,
      include: {
        rules: { orderBy: { createdAt: "asc" } },
        syncTokens: { where: { isConnected: true } },
      },
    });

    return this.mapUserToProfileDto(updatedUser);
  }

  async addRule(
    userId: string,
    dto: CreateUserRuleDto,
  ): Promise<UserRuleDto[]> {
    await this.prisma.lifeRule.create({
      data: {
        userId,
        title: dto.title,
        description: dto.description,
        icon: dto.icon,
      },
    });

    const rules = await this.prisma.lifeRule.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });

    return rules.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      icon: r.icon,
    }));
  }

  async removeRule(userId: string, ruleId: string): Promise<UserRuleDto[]> {
    await this.prisma.lifeRule.deleteMany({
      where: {
        id: ruleId,
        userId,
      },
    });

    const rules = await this.prisma.lifeRule.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });

    return rules.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      icon: r.icon,
    }));
  }

  private mapUserToProfileDto(user: any): UserProfileDto {
    const stravaToken = user.syncTokens?.find(
      (t: any) => t.provider === "strava",
    );
    const stravaSixMonthsSummary = (stravaToken?.metadata as any)
      ?.sixMonthsSummary;

    return {
      id: user.id,
      name: user.name,
      email: user.email,
      initials: user.initials,
      readinessScore: user.readinessScore,
      activeGoal: {
        title: user.activeGoalTitle,
        target: user.activeGoalTarget,
        raceDate: user.activeGoalRaceDate,
        weeksRemaining: user.activeGoalWeeksRemaining,
        progressPercentage: user.activeGoalProgressPercentage,
      },
      stats: {
        activeWeeks: user.activeWeeks,
        totalKm: user.totalKm,
        completedRaces: user.completedRaces,
      },
      rules: user.rules.map((r: any) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        icon: r.icon,
      })),
      connectedApps: user.syncTokens
        ? user.syncTokens.map((t: any) => t.provider)
        : ["garmin", "strava"],
      planType: user.planType === PlanType.PRO ? "pro" : "basic",
      atlFatigue: user.atlFatigue,
      ctlFitness: user.ctlFitness,
      tsbForm: user.tsbForm,
      stravaSixMonthsSummary: stravaSixMonthsSummary || undefined,
    };
  }
}
