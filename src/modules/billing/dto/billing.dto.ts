import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsISO8601, IsOptional, IsString } from "class-validator";
import {
  BILLING_SUBSCRIPTION_STATUSES,
  BillingSubscriptionStatus,
} from "../billing.types";

/**
 * Payload canonique du provider de facturation factice (Phase 5B, B4).
 * Un provider réel (RevenueCat) recevra sa propre forme de payload ; ce DTO
 * documente et valide le contrat du stub. Les champs inconnus sont ignorés par
 * le `ValidationPipe` global (`whitelist: true`).
 */
export class BillingWebhookDto {
  @ApiProperty({ example: "evt_123456" })
  @IsString()
  id: string;

  @ApiProperty({
    example: "initial_purchase",
    description:
      "initial_purchase | renewal | uncancellation | product_change | trial_started | cancellation | expiration",
  })
  @IsString()
  type: string;

  @ApiProperty({ example: "user_abc" })
  @IsString()
  userId: string;

  @ApiPropertyOptional({
    example: "2026-11-01T00:00:00.000Z",
    nullable: true,
  })
  @IsOptional()
  @IsISO8601()
  trialEndsAt?: string;

  @ApiPropertyOptional({
    enum: BILLING_SUBSCRIPTION_STATUSES,
    example: "active",
  })
  @IsOptional()
  @IsIn(BILLING_SUBSCRIPTION_STATUSES as readonly string[])
  status?: BillingSubscriptionStatus;
}
