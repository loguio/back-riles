import { IsEmail, IsIn, IsOptional, IsString, MaxLength } from "class-validator";

export class CreateWaitlistEntryDto {
  @IsEmail({}, { message: "Adresse email invalide" })
  @MaxLength(254)
  email!: string;

  @IsOptional()
  @IsIn(["10k", "semi", "marathon", "trail", "reprise"])
  goal?: string;

  @IsOptional()
  @IsIn(["hero", "navbar", "simulator", "footer", "direct"])
  source?: string;

  @IsOptional()
  @IsIn(["guilt", "injury", "garmin"])
  angle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  utmSource?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  utmMedium?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  utmCampaign?: string;

  /** Honeypot: must stay empty. Bots fill every field. */
  @IsOptional()
  @IsString()
  @MaxLength(0, { message: "Requête refusée" })
  botField?: string;

  /** Client hint only, the server stamps its own truth. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  consentAt?: string;
}
