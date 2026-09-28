import {
  Controller,
  Get,
  Post,
  Body,
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
} from "./dto/onboarding.dto";
import { ReformulateGoalResultDto } from "../llm/dto/llm.dto";
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
  @ApiOperation({ summary: "Finalise l’onboarding et initialise le profil" })
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

