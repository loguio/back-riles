import {
  Controller,
  Get,
  Post,
  Body,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { CoachService } from "./coach.service";
import {
  SendChatMessageDto,
  ChatResponseDto,
  ChatMessageDto,
  QuickPromptDto,
} from "./dto/coach.dto";
import { CurrentUserId } from "../../common/decorators/current-user.decorator";

@ApiTags("Coach & AI")
@Controller("coach")
export class CoachController {
  constructor(private readonly coachService: CoachService) {}

  @Get("history")
  @ApiOperation({
    summary: "Récupère l’historique des échanges avec le Coach IA",
  })
  @ApiResponse({ status: 200, type: [ChatMessageDto] })
  async getHistory(@CurrentUserId() userId: string): Promise<ChatMessageDto[]> {
    return this.coachService.getHistory(userId);
  }

  @Get("quick-prompts")
  @ApiOperation({
    summary: "Récupère la liste des suggestions rapides de messages au Coach",
  })
  @ApiResponse({ status: 200, type: [QuickPromptDto] })
  async getQuickPrompts(): Promise<QuickPromptDto[]> {
    return this.coachService.getQuickPrompts();
  }

  @Post("chat")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Envoie un message au Coach IA et reçoit sa réponse contextuelle",
  })
  @ApiResponse({ status: 200, type: ChatResponseDto })
  async sendMessage(
    @CurrentUserId() userId: string,
    @Body() dto: SendChatMessageDto,
  ): Promise<ChatResponseDto> {
    return this.coachService.processMessage(userId, dto);
  }

  @Post("reset")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Réinitialise le chat avec le Coach" })
  async resetChat(
    @CurrentUserId() userId: string,
  ): Promise<{ success: boolean }> {
    await this.coachService.resetChat(userId);
    return { success: true };
  }
}
