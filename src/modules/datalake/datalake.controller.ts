import { Controller, Post, Body, HttpCode, HttpStatus } from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from "@nestjs/swagger";
import { DataLakeService } from "./datalake.service";
import {
  LogInteractionDto,
  LogInteractionResponseDto,
} from "./dto/datalake.dto";
import { CurrentUserId } from "../../common/decorators/current-user.decorator";

@ApiTags("Data Lake")
@ApiBearerAuth()
@Controller("datalake")
export class DataLakeController {
  constructor(private readonly dataLakeService: DataLakeService) {}

  @Post("log")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Enregistre manuellement une interaction ou un feedback dans le Data Lake (Supabase Storage)",
  })
  @ApiResponse({ status: 200, type: LogInteractionResponseDto })
  async logInteraction(
    @CurrentUserId() userId: string,
    @Body() dto: LogInteractionDto,
  ): Promise<LogInteractionResponseDto> {
    const success = await this.dataLakeService.logTrainingInteraction({
      userId,
      interactionType: dto.interactionType || "custom_interaction",
      interaction: dto.interaction,
      athleteContext: dto.athleteContext,
      feedback: dto.feedback,
      metadata: dto.metadata,
      timestamp: dto.timestamp,
    });

    return {
      success,
      message: success
        ? "Interaction archivée avec succès dans le Data Lake"
        : "Erreur lors de l'archivage dans le Data Lake (voir logs)",
    };
  }
}
