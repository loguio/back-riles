import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";

export interface AthleteContext {
  readinessScore?: number;
  mainGoal?: string;
  activeGoalTitle?: string;
  activeGoalTarget?: string;
  activeGoalRaceDate?: string;
  activeGoalWeeksRemaining?: number;
  totalKm?: number;
  completedRaces?: number;
  selectedSports?: string[];
  [key: string]: any;
}

export interface InteractionData {
  type?: "chat" | "adaptation" | "rpe_check_in" | "workout_generation" | string;
  userPrompt?: string;
  aiResponse?: string;
  suggestedAction?: any;
  adaptationType?: string;
  workoutId?: string;
  workoutDetails?: any;
  [key: string]: any;
}

export interface FeedbackData {
  rating?: number;
  feedbackLabel?: string;
  aiPreservationMessage?: string;
  userComment?: string;
  acceptedSuggestion?: boolean;
  [key: string]: any;
}

export interface TrainingInteractionLogInput {
  userId: string;
  interactionType?: string;
  interaction?: InteractionData | any;
  athleteContext?: AthleteContext | any;
  feedback?: FeedbackData | any;
  metadata?: Record<string, any>;
  timestamp?: string | Date;
}

export interface DatalakeRecord {
  anonymousUserId: string;
  timestamp: string;
  schemaVersion: string;
  year: number;
  month: number;
  day: number;
  interactionType: string;
  interaction: any;
  athleteContext: any;
  feedback: any;
  metadata: Record<string, any>;
}

export class LogInteractionDto {
  @ApiPropertyOptional({ example: "coach_chat" })
  @IsOptional()
  @IsString()
  interactionType?: string;

  @ApiPropertyOptional({
    example: {
      type: "chat",
      userPrompt: "Je me sens fatigué",
      aiResponse: "Repose-toi ce soir",
    },
  })
  @IsOptional()
  interaction?: Record<string, any>;

  @ApiPropertyOptional({
    example: {
      readinessScore: 85,
      mainGoal: "Semi-marathon de Paris",
    },
  })
  @IsOptional()
  athleteContext?: Record<string, any>;

  @ApiPropertyOptional({
    example: {
      rating: 4,
      feedbackLabel: "Modéré",
      acceptedSuggestion: true,
    },
  })
  @IsOptional()
  feedback?: Record<string, any>;

  @ApiPropertyOptional({
    example: {
      source: "mobile_app",
      clientVersion: "1.2.0",
    },
  })
  @IsOptional()
  metadata?: Record<string, any>;

  @ApiPropertyOptional({ example: "2026-09-27T18:00:00.000Z" })
  @IsOptional()
  timestamp?: string;
}

export class LogInteractionResponseDto {
  @ApiProperty({ example: true })
  success: boolean;

  @ApiProperty({
    example: "Interaction archivée avec succès dans le Data Lake",
  })
  message: string;
}
