import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsNumber,
  IsArray,
  IsBoolean,
  IsIn,
} from "class-validator";
import { StravaSixMonthsSummaryDto } from "../../llm/dto/llm.dto";

export class ConnectedAppDto {
  @ApiProperty({ example: "garmin" })
  id: string;

  @ApiProperty({ example: "Garmin" })
  name: string;

  @ApiProperty({ example: "G" })
  code: string;

  @ApiProperty({ example: "#0F172A" })
  color: string;

  @ApiProperty({ example: true })
  isConnected: boolean;
}

export class OnboardingStateDto {
  @ApiProperty({ example: 1 })
  currentStep: number;

  @ApiPropertyOptional({
    example: "apple",
    enum: ["apple", "google", "email", null],
  })
  authMethod: string | null;

  @ApiPropertyOptional({ example: "marius@riles.app" })
  userEmail?: string;

  @ApiProperty({
    example: "Me préparer pour mon premier semi-marathon sans me blesser",
  })
  mainGoal: string;

  @ApiProperty({ example: ["running"], type: [String] })
  selectedSports: string[];

  @ApiProperty({ example: ["garmin", "strava"], type: [String] })
  connectedApps: string[];

  @ApiProperty({ example: "pro", enum: ["basic", "pro"] })
  selectedPlan: "basic" | "pro";

  @ApiProperty({ example: true })
  isCompleted: boolean;

  @ApiPropertyOptional()
  stravaSixMonthsSummary?: StravaSixMonthsSummaryDto;

  @ApiPropertyOptional()
  generatedPlanSummary?: string;

  @ApiPropertyOptional({
    type: Object,
    description:
      "Détail structuré du plan multi-semaines généré à la fin de l'onboarding (résumé, semaines, allures cibles, répartition hebdomadaire et aperçu des séances)",
  })
  generatedPlan?: {
    planSummary: string;
    weeksGenerated: number;
    startWeekNumber: number;
    year: number;
    modelUsed: string;
    totalPlannedSessions: number;
    weeklyBreakdown: Array<{
      weekNumber: number;
      plannedRunningSessions: number;
      restDays: number;
      keySessions: string[];
    }>;
  };
}

export class SyncStravaSixMonthsDto {
  @ApiPropertyOptional({ example: "4c8b1234..." })
  @IsOptional()
  @IsString()
  code?: string;

  @ApiPropertyOptional({ example: "http://localhost:8081/onboarding" })
  @IsOptional()
  @IsString()
  redirectUri?: string;

  @ApiPropertyOptional({ example: "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]" })
  @IsOptional()
  @IsString()
  pushToken?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  forceRefresh?: boolean;
}

export class SaveOnboardingStepDto {
  @ApiPropertyOptional({ example: 2 })
  @IsOptional()
  @IsNumber()
  currentStep?: number;

  @ApiPropertyOptional({ example: "apple" })
  @IsOptional()
  @IsString()
  authMethod?: string;

  @ApiPropertyOptional({ example: "marius@riles.app" })
  @IsOptional()
  @IsString()
  userEmail?: string;

  @ApiPropertyOptional({
    example: "Me préparer pour mon premier semi-marathon",
  })
  @IsOptional()
  @IsString()
  mainGoal?: string;

  @ApiPropertyOptional({ example: ["running"] })
  @IsOptional()
  @IsArray()
  selectedSports?: string[];

  @ApiPropertyOptional({ example: ["garmin", "strava"] })
  @IsOptional()
  @IsArray()
  connectedApps?: string[];

  @ApiPropertyOptional({ example: "pro" })
  @IsOptional()
  @IsString()
  selectedPlan?: "basic" | "pro";

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isCompleted?: boolean;

  @ApiPropertyOptional({
    example: [
      {
        title: "Jours sanctuarisés",
        description: "Aucune séance programmée le jeudi.",
        icon: "calendar-lock",
      },
    ],
  })
  @IsOptional()
  @IsArray()
  extractedRules?: Array<{
    title: string;
    description: string;
    icon: string;
  }>;
}

export class CompleteOnboardingDto extends SaveOnboardingStepDto {}

export class ReformulateOnboardingGoalDto {
  @ApiProperty({
    example:
      "Je veux préparer le semi de Paris en moins de 1h45 sans me blesser aux mollets, pas dispo le jeudi",
  })
  @IsNotEmpty()
  @IsString()
  rawGoal: string;
}

