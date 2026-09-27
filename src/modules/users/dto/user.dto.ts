import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsNumber,
  IsArray,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

export class UserRuleDto {
  @ApiProperty({ example: "rule-1" })
  id: string;

  @ApiProperty({ example: "Rester régulier" })
  title: string;

  @ApiProperty({ example: "La constance avant l’intensité." })
  description: string;

  @ApiProperty({ example: "bullseye-arrow" })
  icon: string;
}

export class CreateUserRuleDto {
  @ApiProperty({ example: "Rester régulier" })
  @IsNotEmpty()
  @IsString()
  title: string;

  @ApiProperty({ example: "La constance avant l’intensité." })
  @IsNotEmpty()
  @IsString()
  description: string;

  @ApiProperty({ example: "bullseye-arrow" })
  @IsNotEmpty()
  @IsString()
  icon: string;
}

export class ActiveGoalDto {
  @ApiProperty({ example: "Semi-marathon de Paris" })
  @IsString()
  title: string;

  @ApiProperty({ example: "Passer sous les 2h" })
  @IsString()
  target: string;

  @ApiProperty({ example: "17 mars 2025" })
  @IsString()
  raceDate: string;

  @ApiProperty({ example: 6 })
  @IsNumber()
  weeksRemaining: number;

  @ApiProperty({ example: 65 })
  @IsNumber()
  progressPercentage: number;
}

export class UserStatsDto {
  @ApiProperty({ example: 12 })
  @IsNumber()
  activeWeeks: number;

  @ApiProperty({ example: 328 })
  @IsNumber()
  totalKm: number;

  @ApiProperty({ example: 4 })
  @IsNumber()
  completedRaces: number;
}

export class UserProfileDto {
  @ApiProperty({ example: "user-01" })
  id: string;

  @ApiProperty({ example: "Marius" })
  name: string;

  @ApiProperty({ example: "marius@riles.app" })
  email: string;

  @ApiProperty({ example: "ML" })
  initials: string;

  @ApiProperty({ example: 88 })
  readinessScore: number;

  @ApiProperty({ type: ActiveGoalDto })
  activeGoal: ActiveGoalDto;

  @ApiProperty({ type: UserStatsDto })
  stats: UserStatsDto;

  @ApiProperty({ type: [UserRuleDto] })
  rules: UserRuleDto[];

  @ApiProperty({ example: ["garmin", "strava"] })
  connectedApps: string[];

  @ApiProperty({ example: "pro", enum: ["basic", "pro"] })
  planType: "basic" | "pro";
}

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: "Marius" })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: 88 })
  @IsOptional()
  @IsNumber()
  readinessScore?: number;

  @ApiPropertyOptional({ type: ActiveGoalDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ActiveGoalDto)
  activeGoal?: Partial<ActiveGoalDto>;

  @ApiPropertyOptional({ example: "pro", enum: ["basic", "pro"] })
  @IsOptional()
  @IsString()
  planType?: "basic" | "pro";

  @ApiPropertyOptional({ example: ["garmin", "strava"] })
  @IsOptional()
  @IsArray()
  connectedApps?: string[];
}
