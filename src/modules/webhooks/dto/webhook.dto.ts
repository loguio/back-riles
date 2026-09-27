import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsObject,
  IsNumber,
} from "class-validator";

export class StravaWebhookQueryDto {
  @ApiProperty({ example: "subscribe" })
  @IsString()
  "hub.mode": string;

  @ApiProperty({ example: "15f7d8a6fc4e464c3f10151010f459c4" })
  @IsString()
  "hub.challenge": string;

  @ApiProperty({ example: "riles_strava_webhook_token_2026" })
  @IsString()
  "hub.verify_token": string;
}

export class StravaEventDto {
  @ApiProperty({ example: "activity" })
  @IsString()
  object_type: string;

  @ApiProperty({ example: 1234567890 })
  @IsNumber()
  object_id: number;

  @ApiProperty({ example: "create" })
  @IsString()
  aspect_type: string;

  @ApiProperty({ example: 987654 })
  @IsNumber()
  owner_id: number;

  @ApiPropertyOptional({ example: 1516126040 })
  @IsOptional()
  @IsNumber()
  event_time?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  updates?: Record<string, any>;
}

export class GarminWebhookEventDto {
  @ApiProperty({ example: "activities" })
  @IsString()
  type: string;

  @ApiProperty({ example: "garmin_usr_12345" })
  @IsString()
  userId: string;

  @ApiProperty()
  @IsObject()
  data: Record<string, any>;
}

export class AppleHealthSyncDto {
  @ApiProperty({ example: "user-01" })
  @IsString()
  userId: string;

  @ApiProperty({ example: "running" })
  @IsString()
  activityType: string;

  @ApiProperty({ example: 8500 })
  @IsNumber()
  distanceMeters: number;

  @ApiProperty({ example: 2400 })
  @IsNumber()
  durationSeconds: number;

  @ApiProperty({ example: "2026-10-14T18:30:00Z" })
  @IsString()
  startDate: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class WebhookResponseDto {
  @ApiProperty({ example: true })
  success: boolean;

  @ApiProperty({ example: "Event processed successfully" })
  message: string;
}
