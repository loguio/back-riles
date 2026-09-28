import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse, ApiQuery } from "@nestjs/swagger";
import { WorkoutsService } from "./workouts.service";
import {
  WorkoutSessionDto,
  UpdateWorkoutDto,
  RpeCheckInRequestDto,
  RpeCheckInResponseDto,
  AdaptWorkoutDto,
  GenerateMultiWeekPlanRequestDto,
  GenerateMultiWeekPlanResponseDto,
} from "./dto/workout.dto";
import { CurrentUserId } from "../../common/decorators/current-user.decorator";

@ApiTags("Workouts & Planning")
@Controller("workouts")
export class WorkoutsController {
  constructor(private readonly workoutsService: WorkoutsService) {}

  @Post("generate-plan")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Génère un plan multi-semaines complet via le meilleur LLM (LLM_PRO_MODEL) en respectant tout le contexte athlète et les règles de vie, puis l'enregistre en base de données",
  })
  @ApiResponse({ status: 200, type: GenerateMultiWeekPlanResponseDto })
  async generateMultiWeekPlan(
    @CurrentUserId() userId: string,
    @Body() dto: GenerateMultiWeekPlanRequestDto,
  ): Promise<GenerateMultiWeekPlanResponseDto> {
    return this.workoutsService.generateAndSaveMultiWeekPlan(userId, dto);
  }

  @Get("week")
  @ApiOperation({ summary: "Récupère les 7 séances de la semaine active" })
  @ApiQuery({ name: "week", required: false, example: 42 })
  @ApiQuery({ name: "year", required: false, example: 2026 })
  @ApiResponse({ status: 200, type: [WorkoutSessionDto] })
  async getWeek(
    @CurrentUserId() userId: string,
    @Query("week") week?: number,
    @Query("year") year?: number,
  ): Promise<WorkoutSessionDto[]> {
    return this.workoutsService.getWeekWorkouts(
      userId,
      week ? Number(week) : 42,
      year ? Number(year) : 2026,
    );
  }

  @Get("month")
  @ApiOperation({
    summary:
      "Récupère toutes les séances du mois sous forme de Record<dateKey, Workout>",
  })
  @ApiQuery({ name: "month", required: false, example: 9 })
  @ApiQuery({ name: "year", required: false, example: 2026 })
  @ApiResponse({
    status: 200,
    description: "Map de dateKey vers WorkoutSession",
  })
  async getMonth(
    @CurrentUserId() userId: string,
    @Query("month") month?: number,
    @Query("year") year?: number,
  ): Promise<Record<string, WorkoutSessionDto>> {
    return this.workoutsService.getMonthWorkouts(
      userId,
      month ? Number(month) : 9,
      year ? Number(year) : 2026,
    );
  }

  @Get(":identifier")
  @ApiOperation({
    summary:
      "Récupère le détail d’une séance par son ID ou sa dateKey (YYYY-MM-DD)",
  })
  @ApiResponse({ status: 200, type: WorkoutSessionDto })
  async getOne(
    @CurrentUserId() userId: string,
    @Param("identifier") identifier: string,
  ): Promise<WorkoutSessionDto> {
    return this.workoutsService.getWorkoutByIdOrDateKey(userId, identifier);
  }

  @Patch(":identifier")
  @ApiOperation({ summary: "Met à jour une séance (statut, titre, tags)" })
  @ApiResponse({ status: 200, type: WorkoutSessionDto })
  async update(
    @CurrentUserId() userId: string,
    @Param("identifier") identifier: string,
    @Body() dto: UpdateWorkoutDto,
  ): Promise<WorkoutSessionDto> {
    return this.workoutsService.updateWorkout(userId, identifier, dto);
  }

  @Post("rpe")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Soumet une note d’effort RPE (1-10) et calcule le feedback de préservation IA",
  })
  @ApiResponse({ status: 200, type: RpeCheckInResponseDto })
  async submitRpe(
    @CurrentUserId() userId: string,
    @Body() dto: RpeCheckInRequestDto,
  ): Promise<RpeCheckInResponseDto> {
    return this.workoutsService.submitRpeCheckIn(userId, dto);
  }

  @Post(":identifier/adapt")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Applique une adaptation IA sur une séance (alléger, décaler, footing cool, mollet)",
  })
  @ApiResponse({ status: 200, type: WorkoutSessionDto })
  async adaptSession(
    @CurrentUserId() userId: string,
    @Param("identifier") identifier: string,
    @Body() dto: AdaptWorkoutDto,
  ): Promise<WorkoutSessionDto> {
    return this.workoutsService.adaptSessionWithAI(userId, identifier, dto);
  }
}
