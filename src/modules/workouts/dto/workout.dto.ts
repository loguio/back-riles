import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsOptional,
  IsString,
  IsNumber,
  IsArray,
  IsIn,
  Min,
  Max,
} from "class-validator";

export class EffortBlockDto {
  @ApiProperty({ example: "Seuil" })
  @IsString()
  title: string;

  @ApiProperty({ example: "3 × 8 min" })
  @IsString()
  durationLabel: string;

  @ApiProperty({
    example: "threshold",
    enum: ["warmup", "threshold", "cooldown", "interval", "recovery"],
  })
  @IsIn(["warmup", "threshold", "cooldown", "interval", "recovery"])
  type: "warmup" | "threshold" | "cooldown" | "interval" | "recovery";

  @ApiProperty({ example: 2 })
  @IsNumber()
  flexRatio: number;
}

export class TargetZoneSegmentDto {
  @ApiProperty({ example: "#93C5FD" })
  @IsString()
  color: string;

  @ApiProperty({ example: 1.2 })
  @IsNumber()
  flex: number;
}

export class WorkoutSessionDto {
  @ApiProperty({ example: "w-14" })
  id: string;

  @ApiProperty({ example: "2026-10-14" })
  dateKey: string;

  @ApiProperty({ example: "Mer" })
  dayName: string;

  @ApiProperty({ example: 14 })
  dayNumber: number;

  @ApiPropertyOptional({ example: 9 })
  month?: number;

  @ApiPropertyOptional({ example: 2026 })
  year?: number;

  @ApiPropertyOptional({ example: 42 })
  weekNumber?: number;

  @ApiProperty({ example: "MERCREDI 14 OCTOBRE" })
  fullDateLabel: string;

  @ApiPropertyOptional({ example: "AUJOURD'HUI • 18:30" })
  timeLabel?: string;

  @ApiProperty({
    example: "selected",
    enum: ["done", "selected", "rest", "upcoming"],
  })
  status: "done" | "selected" | "rest" | "upcoming";

  @ApiProperty({ example: false })
  isRestDay: boolean;

  @ApiProperty({ example: "SÉANCE QUALITATIVE" })
  category: string;

  @ApiProperty({ example: "Sortie Seuil & Allure Cible" })
  title: string;

  @ApiProperty({ example: "1h15" })
  duration: string;

  @ApiProperty({ example: "14 km" })
  distance: string;

  @ApiProperty({ example: "4:50/km" })
  targetPace: string;

  @ApiProperty({ example: "Zone 3–4" })
  targetZoneLabel: string;

  @ApiProperty({ example: "158–172 bpm" })
  targetZoneBpm: string;

  @ApiProperty({ type: [TargetZoneSegmentDto] })
  targetZoneSegments: TargetZoneSegmentDto[];

  @ApiProperty({ example: 68 })
  pinPositionPercent: number;

  @ApiProperty({ type: [EffortBlockDto] })
  effortBlocks: EffortBlockDto[];

  @ApiPropertyOptional({
    example: ["8,5 km", "Allure cible : 4:45/km", "Zone 3/4"],
  })
  tags?: string[];

  @ApiPropertyOptional({
    example: "Séance allégée à ta demande : 35 min en Zone 2 (allure 5:30/km).",
  })
  aiAdjustmentNote?: string;

  // Données complètes de la vraie séance réalisée (issues des webhooks Strava / Garmin / Apple Santé)
  @ApiPropertyOptional({ example: "1234567890" })
  externalActivityId?: string;

  @ApiPropertyOptional({ example: "strava" })
  sourceProvider?: string;

  @ApiPropertyOptional({ example: 14.2 })
  actualDistanceKm?: number;

  @ApiPropertyOptional({ example: 4180 })
  actualDurationSec?: number;

  @ApiPropertyOptional({ example: "4:54/km" })
  actualPace?: string;

  @ApiPropertyOptional({ example: 161 })
  actualAvgHeartRate?: number;

  @ApiPropertyOptional({ example: 179 })
  actualMaxHeartRate?: number;

  @ApiPropertyOptional({ example: 115 })
  actualElevationGain?: number;

  @ApiPropertyOptional({ example: 820 })
  actualCalories?: number;

  @ApiPropertyOptional({ example: 178 })
  actualCadence?: number;

  @ApiPropertyOptional()
  actualSplitsJson?: any;

  @ApiPropertyOptional({ example: 68 })
  tss?: number;

  @ApiPropertyOptional({ example: "2026-10-14T19:45:00.000Z" })
  completedAt?: string;

  @ApiPropertyOptional({ example: "running" })
  sportType?: string;

  @ApiPropertyOptional({ example: false })
  isCommute?: boolean;

  @ApiPropertyOptional()
  secondaryActivities?: any[];
}

export class UpdateWorkoutDto {
  @ApiPropertyOptional({
    example: "done",
    enum: ["done", "selected", "rest", "upcoming"],
  })
  @IsOptional()
  @IsIn(["done", "selected", "rest", "upcoming"])
  status?: "done" | "selected" | "rest" | "upcoming";

  @ApiPropertyOptional({ example: "Sortie Seuil & Allure Cible" })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiPropertyOptional({ example: "1h15" })
  @IsOptional()
  @IsString()
  duration?: string;

  @ApiPropertyOptional({ example: "14 km" })
  @IsOptional()
  @IsString()
  distance?: string;

  @ApiPropertyOptional({ example: "4:50/km" })
  @IsOptional()
  @IsString()
  targetPace?: string;

  @ApiPropertyOptional({ example: "Zone 3–4" })
  @IsOptional()
  @IsString()
  targetZoneLabel?: string;

  @ApiPropertyOptional({ example: "158–172 bpm" })
  @IsOptional()
  @IsString()
  targetZoneBpm?: string;

  @ApiPropertyOptional({
    example: "Séance allégée à ta demande : 35 min en Zone 2.",
  })
  @IsOptional()
  @IsString()
  aiAdjustmentNote?: string;

  @ApiPropertyOptional({ example: ["8,5 km", "Zone 3/4"] })
  @IsOptional()
  @IsArray()
  tags?: string[];
}

export class RpeCheckInRequestDto {
  @ApiProperty({ example: 5, minimum: 1, maximum: 10 })
  @IsNumber()
  @Min(1)
  @Max(10)
  rating: number;

  @ApiPropertyOptional({ example: "w-14" })
  @IsOptional()
  @IsString()
  workoutId?: string;

  @ApiPropertyOptional({
    example: "Sensations fluides mais mollets un peu raides sur la fin",
  })
  @IsOptional()
  @IsString()
  textComment?: string;

  @ApiPropertyOptional({ example: "légères" })
  @IsOptional()
  @IsString()
  perceivedLegs?: string;
}

export class RpeCheckInResponseDto {
  @ApiProperty({ example: 5 })
  rating: number;

  @ApiProperty({ example: "Modéré" })
  feedbackLabel: string;

  @ApiPropertyOptional({ example: "Sensations fluides" })
  textComment?: string;

  @ApiPropertyOptional({ example: "légères" })
  perceivedLegs?: string;

  @ApiPropertyOptional({ example: "2026-10-14T18:35:00.000Z" })
  submittedAt?: string;

  @ApiProperty({
    example:
      "Effort modéré, cohérent avec l'intention de la séance. Rien à ajuster dans ton plan sur cette base.",
  })
  aiPreservationMessage: string;
}

export class AdaptWorkoutDto {
  @ApiProperty({
    example: "lighten",
    enum: ["lighten", "postpone", "easy_run", "injury_care"],
  })
  @IsIn(["lighten", "postpone", "easy_run", "injury_care"])
  adaptationType: "lighten" | "postpone" | "easy_run" | "injury_care";
}

export class GenerateMultiWeekPlanRequestDto {
  @ApiPropertyOptional({ example: 42 })
  @IsOptional()
  @IsNumber()
  startWeekNumber?: number;

  @ApiPropertyOptional({ example: 2026 })
  @IsOptional()
  @IsNumber()
  year?: number;

  @ApiPropertyOptional({ example: 12, minimum: 1, maximum: 104 })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(104)
  weeksToGenerate?: number;
}

export class GenerateMultiWeekPlanResponseDto {
  @ApiProperty({ example: true })
  success: boolean;

  @ApiProperty({
    example:
      "Ton plan de 4 semaines a été généré en respectant tes règles de vie, avec des allures calibrées sur tes séances récentes.",
  })
  planSummary: string;

  @ApiProperty({ example: 4 })
  weeksGenerated: number;

  @ApiProperty({ example: "google/gemini-2.5-pro" })
  modelUsed: string;

  @ApiProperty({ type: [WorkoutSessionDto] })
  workouts: WorkoutSessionDto[];
}
