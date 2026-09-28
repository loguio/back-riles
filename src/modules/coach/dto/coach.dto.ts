import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsNumber,
  IsIn,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

export class CoachContextDto {
  @ApiPropertyOptional({ example: "Sortie Seuil & Allure Cible" })
  @IsOptional()
  @IsString()
  activeSessionTitle?: string;

  @ApiPropertyOptional({ example: 88 })
  @IsOptional()
  @IsNumber()
  readinessScore?: number;

  @ApiPropertyOptional({ example: 7 })
  @IsOptional()
  @IsNumber()
  lastRpe?: number;
}

export class SuggestedActionDto {
  @ApiProperty({
    example: "reduce_intensity",
    enum: [
      "adjust_workout",
      "reschedule",
      "reduce_intensity",
      "add_life_rule",
    ],
  })
  @IsIn([
    "adjust_workout",
    "reschedule",
    "reduce_intensity",
    "add_life_rule",
  ])
  type:
    | "adjust_workout"
    | "reschedule"
    | "reduce_intensity"
    | "add_life_rule";

  @ApiProperty({ example: "Appliquer : Alléger la séance à 35 min" })
  label: string;

  @ApiProperty({ example: false })
  applied: boolean;

  @ApiPropertyOptional({ example: "w-14" })
  workoutId?: string;

  @ApiPropertyOptional({ example: "lighten" })
  details?: string;

  @ApiPropertyOptional({
    example: {
      title: "Jours sanctuarisés",
      description: "Aucune séance programmée le jeudi.",
      icon: "calendar-lock",
    },
  })
  ruleData?: {
    title: string;
    description: string;
    icon: string;
  };
}

export class ChatMessageDto {
  @ApiProperty({ example: "coach-123" })
  id: string;

  @ApiProperty({ example: "coach", enum: ["user", "coach", "system"] })
  sender: "user" | "coach" | "system";

  @ApiProperty({ example: "Bonjour Marius ! Comment te sens-tu ?" })
  text: string;

  @ApiProperty({ example: "18:30" })
  timestamp: string;

  @ApiPropertyOptional({ type: SuggestedActionDto })
  suggestedAction?: SuggestedActionDto;
}

export class SendChatMessageDto {
  @ApiProperty({ example: "Je me sens fatigué ce soir" })
  @IsNotEmpty()
  @IsString()
  text: string;

  @ApiPropertyOptional({ type: CoachContextDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CoachContextDto)
  context?: CoachContextDto;
}

export class ChatResponseDto {
  @ApiProperty({ type: ChatMessageDto })
  userMsg: ChatMessageDto;

  @ApiProperty({ type: ChatMessageDto })
  coachReply: ChatMessageDto;
}

export class QuickPromptDto {
  @ApiProperty({ example: "qp-1" })
  id: string;

  @ApiProperty({ example: "Je suis fatigué ce soir" })
  label: string;

  @ApiProperty({
    example:
      "Je me sens très fatigué après ma journée de travail, dois-je maintenir ma séance ?",
  })
  message: string;
}
