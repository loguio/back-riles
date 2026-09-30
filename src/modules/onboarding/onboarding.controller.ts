import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { OnboardingService } from "./onboarding.service";
import {
  OnboardingStateDto,
  ConnectedAppDto,
  SaveOnboardingStepDto,
  CompleteOnboardingDto,
  ReformulateOnboardingGoalDto,
  SyncStravaSixMonthsDto,
} from "./dto/onboarding.dto";
import {
  ReformulateGoalResultDto,
  StravaSixMonthsSummaryDto,
} from "../llm/dto/llm.dto";
import { CurrentUserId } from "../../common/decorators/current-user.decorator";

@ApiTags("Onboarding")
@Controller("onboarding")
export class OnboardingController {
  constructor(private readonly onboardingService: OnboardingService) {}

  @Get("state")
  @ApiOperation({ summary: "Récupère l’état courant de l’onboarding" })
  @ApiResponse({ status: 200, type: OnboardingStateDto })
  async getState(@CurrentUserId() userId: string): Promise<OnboardingStateDto> {
    return this.onboardingService.getOnboardingState(userId);
  }

  @Get("apps")
  @ApiOperation({
    summary: "Récupère le catalogue des applications sportives connectables",
  })
  @ApiResponse({ status: 200, type: [ConnectedAppDto] })
  async getAppsCatalog(
    @CurrentUserId() userId: string,
  ): Promise<ConnectedAppDto[]> {
    return this.onboardingService.getAppsCatalog(userId);
  }

  @Get("oauth/strava/url")
  @ApiOperation({
    summary:
      "Génère l’URL d’autorisation OAuth2 Strava (Scope : 6 derniers mois d’activités & profil cardio)",
  })
  getStravaOAuthUrl(@Query("redirectUri") redirectUri?: string) {
    return this.onboardingService.getStravaOAuthUrl(redirectUri);
  }

  @Post("strava/sync-six-months")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Connecte Strava (OAuth2 ou import direct), récupère et sauvegarde les 6 derniers mois de séances Strava dans l’application et le contexte IA",
  })
  async syncStravaSixMonths(
    @CurrentUserId() userId: string,
    @Body() dto: SyncStravaSixMonthsDto,
  ): Promise<StravaSixMonthsSummaryDto> {
    return this.onboardingService.syncStravaSixMonths(userId, dto);
  }

  @Post("reformulate-goal")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Reformule l’objectif libre de l’utilisateur avec l’IA, extrait ses règles de vie et vérifie l’éligibilité physiologique",
  })
  @ApiResponse({ status: 200, type: ReformulateGoalResultDto })
  async reformulateGoal(
    @CurrentUserId() userId: string,
    @Body() dto: ReformulateOnboardingGoalDto,
  ): Promise<ReformulateGoalResultDto> {
    return this.onboardingService.reformulateGoal(userId, dto.rawGoal);
  }

  @Post("step")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Enregistre les données d’une étape de l’onboarding",
  })
  @ApiResponse({ status: 200, type: OnboardingStateDto })
  async saveStep(
    @CurrentUserId() userId: string,
    @Body() dto: SaveOnboardingStepDto,
  ): Promise<OnboardingStateDto> {
    return this.onboardingService.saveStepData(userId, dto);
  }

  @Post("complete")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Finalise l’onboarding, synchronise les 6 mois de données Strava et génère le plan d’entraînement multi-semaines sur-mesure",
  })
  @ApiResponse({ status: 200, type: OnboardingStateDto })
  async complete(
    @CurrentUserId() userId: string,
    @Body() dto: CompleteOnboardingDto,
  ): Promise<OnboardingStateDto> {
    return this.onboardingService.completeOnboarding(userId, dto);
  }

  @Post("reset")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Réinitialise l’onboarding pour tests" })
  @ApiResponse({ status: 200, type: OnboardingStateDto })
  async reset(@CurrentUserId() userId: string): Promise<OnboardingStateDto> {
    return this.onboardingService.resetOnboarding(userId);
  }
}

