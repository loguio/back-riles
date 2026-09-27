import { Controller, Post, Body, HttpCode, HttpStatus } from "@nestjs/common";
import { ApiTags, ApiOperation, ApiResponse } from "@nestjs/swagger";
import { AuthService } from "./auth.service";
import {
  LoginDto,
  SocialAuthDto,
  RegisterDto,
  AuthResponseDto,
} from "./dto/auth.dto";
import { Public } from "../../common/decorators/public.decorator";

@ApiTags("Auth")
@Controller("auth")
@Public()
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post("login")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Connexion classique par email" })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  async login(@Body() dto: LoginDto): Promise<AuthResponseDto> {
    return this.authService.login(dto);
  }

  @Post("social")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Connexion / Inscription Apple, Google ou Email rapide",
  })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  async socialAuth(@Body() dto: SocialAuthDto): Promise<AuthResponseDto> {
    return this.authService.socialAuth(dto);
  }

  @Post("register")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Création de compte" })
  @ApiResponse({ status: 201, type: AuthResponseDto })
  async register(@Body() dto: RegisterDto): Promise<AuthResponseDto> {
    return this.authService.register(dto);
  }
}
