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
}

export class CompleteOnboardingDto extends SaveOnboardingStepDto {}
