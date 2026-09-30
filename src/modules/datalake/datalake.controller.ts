import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
  ApiQuery,
} from "@nestjs/swagger";
import { DataLakeService } from "./datalake.service";
import {
  LogInteractionDto,
  LogInteractionResponseDto,
} from "./dto/datalake.dto";
import { CurrentUserId } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";

@ApiTags("Data Lake")
@ApiBearerAuth()
@Controller("datalake")
export class DataLakeController {
  constructor(private readonly dataLakeService: DataLakeService) {}

  @Post("log")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Enregistre manuellement une interaction ou un feedback dans le Data Lake (JSONL local + Supabase Storage)",
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

  @Get("logs")
  @Public()
  @ApiOperation({
    summary:
      "Consulte les derniers enregistrements anonymisés archivés automatiquement dans le Data Lake",
  })
  @ApiQuery({ name: "limit", required: false, example: 50 })
  @ApiQuery({
    name: "type",
    required: false,
    example: "webhook_activity_synced",
  })
  getRecentLogs(
    @Query("limit") limit?: number,
    @Query("type") interactionType?: string,
  ) {
    return {
      stats: this.dataLakeService.getStats(),
      records: this.dataLakeService.getRecentLogs(
        limit ? Number(limit) : 50,
        interactionType,
      ),
    };
  }

  @Get("stats")
  @Public()
  @ApiOperation({
    summary:
      "Statistiques temps réel des flux automatiquement archivés dans le Data Lake (Flux A Coach/Onboarding & Flux B Webhooks/RPE)",
  })
  getStats() {
    return this.dataLakeService.getStats();
  }
}
