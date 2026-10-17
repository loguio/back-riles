import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from "@nestjs/swagger";
import { CommunityService } from "./community.service";
import {
  CommunityRunDto,
  MonthlyChallengeDto,
  ToggleRunParticipationRequestDto,
  ToggleRunParticipationResponseDto,
  GetCommunityRunsQueryDto,
} from "./dto/community.dto";
import { CurrentUserId } from "../../common/decorators/current-user.decorator";

@ApiTags("Community")
@Controller("community")
export class CommunityController {
  constructor(private readonly communityService: CommunityService) {}

  @Get("runs")
  @ApiOperation({
    summary:
      "Liste les sorties collectives à venir (club, participants, et si l'utilisateur courant y est inscrit)",
  })
  @ApiQuery({ name: "clubId", required: false, example: "club-01" })
  @ApiResponse({ status: 200, type: [CommunityRunDto] })
  @ApiResponse({ status: 400, description: "clubId invalide" })
  async getRuns(
    @CurrentUserId() userId: string,
    @Query() query: GetCommunityRunsQueryDto,
  ): Promise<CommunityRunDto[]> {
    return this.communityService.getRuns(userId, query.clubId);
  }

  @Post("runs/:id/toggle")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Rejoint ou quitte une sortie collective (idempotent selon action: join | leave | toggle)",
  })
  @ApiResponse({ status: 200, type: ToggleRunParticipationResponseDto })
  @ApiResponse({ status: 400, description: "action invalide" })
  @ApiResponse({ status: 404, description: "Sortie introuvable" })
  async toggleParticipation(
    @CurrentUserId() userId: string,
    @Param("id") id: string,
    @Body() dto: ToggleRunParticipationRequestDto,
  ): Promise<ToggleRunParticipationResponseDto> {
    return this.communityService.toggleParticipation(userId, id, dto?.action);
  }

  @Get("challenges")
  @ApiOperation({
    summary:
      "Défis mensuels en cours, avec la progression de l'utilisateur courant",
  })
  @ApiResponse({ status: 200, type: [MonthlyChallengeDto] })
  async getChallenges(
    @CurrentUserId() userId: string,
  ): Promise<MonthlyChallengeDto[]> {
    return this.communityService.getChallenges(userId);
  }
}
