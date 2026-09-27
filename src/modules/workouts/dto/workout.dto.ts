import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsNumber,
  IsArray,
  IsBoolean,
  IsIn,
  Min,
  Max,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

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
    example: "L'IA a ajusté le seuil pour préserver tes mollets aujourd'hui.",
  })
  aiAdjustmentNote?: string;
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

  @ApiPropertyOptional({ example: "L'IA a ajusté le seuil." })
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
}

export class RpeCheckInResponseDto {
  @ApiProperty({ example: 5 })
  rating: number;

  @ApiProperty({ example: "Modéré" })
  feedbackLabel: string;

  @ApiPropertyOptional({ example: "2026-10-14T18:35:00.000Z" })
  submittedAt?: string;

  @ApiProperty({
    example: "L'IA a ajusté le seuil pour préserver tes mollets aujourd'hui.",
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
