import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, IsIn } from "class-validator";

/**
 * X1 — Contrat d'API Community (Phase 5B).
 *
 * Ces DTOs décrivent les trois endpoints exposés par le CommunityModule (B2,
 * itération 1) : `GET /community/runs`, `POST /community/runs/:id/toggle` et
 * `GET /community/challenges`. Le front peut se construire contre ces formes
 * (voir CONTRACT-community.md) avant que le contrôleur n'existe.
 */

export const CHALLENGE_METRICS = [
  "distance",
  "duration",
  "elevation",
  "sessions",
] as const;

export type ChallengeMetric = (typeof CHALLENGE_METRICS)[number];

/** Un participant exposé dans une sortie (données publiques minimales). */
export class CommunityRunParticipantDto {
  @ApiProperty({ example: "user-01" })
  userId: string;

  @ApiProperty({ example: "Camille D." })
  name: string;

  @ApiProperty({ example: "CD" })
  initials: string;

  @ApiProperty({ example: true })
  isMe: boolean;
}

/** Une sortie collective telle que renvoyée par `GET /community/runs`. */
export class CommunityRunDto {
  @ApiProperty({ example: "run-01" })
  id: string;

  @ApiProperty({ example: "club-01" })
  clubId: string;

  @ApiProperty({ example: "Riles Paris" })
  clubName: string;

  @ApiProperty({ example: "2026-10-20T18:30:00.000Z" })
  scheduledAt: string;

  @ApiProperty({ example: "Parc des Buttes-Chaumont, Paris" })
  location: string;

  @ApiPropertyOptional({ example: "Sortie seuil en groupe" })
  theme?: string;

  @ApiProperty({ example: 12 })
  participantCount: number;

  @ApiProperty({ example: true })
  isJoined: boolean;

  @ApiProperty({ type: [CommunityRunParticipantDto] })
  participants: CommunityRunParticipantDto[];
}

/** Réponse de `POST /community/runs/:id/toggle` après bascule de l'inscription. */
export class ToggleRunParticipationResponseDto {
  @ApiProperty({ example: "run-01" })
  runId: string;

  @ApiProperty({
    example: true,
    description: "true = l'utilisateur est désormais inscrit, false = désinscrit",
  })
  isJoined: boolean;

  @ApiProperty({ example: 13 })
  participantCount: number;
}

/** Un défi mensuel tel que renvoyé par `GET /community/challenges`. */
export class MonthlyChallengeDto {
  @ApiProperty({ example: "challenge-01" })
  id: string;

  @ApiProperty({ example: "100 km en octobre" })
  title: string;

  @ApiProperty({ example: "distance", enum: CHALLENGE_METRICS })
  metric: ChallengeMetric;

  @ApiProperty({ example: 100 })
  target: number;

  @ApiProperty({ example: "km" })
  unit: string;

  @ApiProperty({ example: 42.5, description: "Progression actuelle de l'utilisateur" })
  progress: number;

  @ApiProperty({ example: 0.425, description: "progress / target, borné à [0, 1]" })
  progressRatio: number;

  @ApiProperty({ example: "2026-10-01T00:00:00.000Z" })
  periodStart: string;

  @ApiProperty({ example: "2026-10-31T23:59:59.999Z" })
  periodEnd: string;
}

/** Query optionnelle de `GET /community/runs` (filtrage par club). */
export class GetCommunityRunsQueryDto {
  @ApiPropertyOptional({ example: "club-01" })
  @IsOptional()
  @IsString()
  clubId?: string;
}

/** Corps optionnel de `POST /community/runs/:id/toggle` (métrique d'inscription). */
export class ToggleRunParticipationRequestDto {
  @ApiPropertyOptional({
    example: "join",
    enum: ["join", "leave"],
    description:
      "Omettez pour basculer (toggle) ; précisez pour forcer l'état cible.",
  })
  @IsOptional()
  @IsIn(["join", "leave"])
  action?: "join" | "leave";
}
