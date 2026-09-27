import {
  Controller,
  Get,
  Patch,
  Post,
  Delete,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { UsersService } from "./users.service";
import {
  UserProfileDto,
  UpdateProfileDto,
  CreateUserRuleDto,
  UserRuleDto,
} from "./dto/user.dto";
import { CurrentUserId } from "../../common/decorators/current-user.decorator";

@ApiTags("Users & Profile")
@Controller("users")
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get("profile")
  @ApiOperation({ summary: "Récupère le profil complet de l’utilisateur" })
  @ApiResponse({ status: 200, type: UserProfileDto })
  async getProfile(@CurrentUserId() userId: string): Promise<UserProfileDto> {
    return this.usersService.getProfile(userId);
  }

  @Patch("profile")
  @ApiOperation({
    summary:
      "Met à jour le profil de l’utilisateur (objectif, score de forme, plan)",
  })
  @ApiResponse({ status: 200, type: UserProfileDto })
  async updateProfile(
    @CurrentUserId() userId: string,
    @Body() dto: UpdateProfileDto,
  ): Promise<UserProfileDto> {
    return this.usersService.updateProfile(userId, dto);
  }

  @Post("rules")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Ajoute une nouvelle règle de vie / contrainte" })
  @ApiResponse({ status: 201, type: [UserRuleDto] })
  async addRule(
    @CurrentUserId() userId: string,
    @Body() dto: CreateUserRuleDto,
  ): Promise<UserRuleDto[]> {
    return this.usersService.addRule(userId, dto);
  }

  @Delete("rules/:id")
  @ApiOperation({ summary: "Supprime une règle de vie par son ID" })
  @ApiResponse({ status: 200, type: [UserRuleDto] })
  async removeRule(
    @CurrentUserId() userId: string,
    @Param("id") ruleId: string,
  ): Promise<UserRuleDto[]> {
    return this.usersService.removeRule(userId, ruleId);
  }
}
