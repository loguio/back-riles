import { Injectable, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { PrismaService } from "../../prisma/prisma.service";
import {
  LoginDto,
  SocialAuthDto,
  RegisterDto,
  AuthResponseDto,
} from "./dto/auth.dto";
import { AuthProvider, PlanType } from "@prisma/client";

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async login(dto: LoginDto): Promise<AuthResponseDto> {
    let user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      // In development / demo mode, auto-create user if not found
      const initials = dto.email.slice(0, 2).toUpperCase();
      user = await this.prisma.user.create({
        data: {
          email: dto.email,
          name: dto.email.split("@")[0],
          initials,
          planType: PlanType.PRO,
          authProvider: AuthProvider.EMAIL,
        },
      });
    }

    const payload = { sub: user.id, email: user.email };
    const accessToken = this.jwtService.sign(payload);

    return {
      accessToken,
      userId: user.id,
      email: user.email,
      name: user.name,
    };
  }

  async socialAuth(dto: SocialAuthDto): Promise<AuthResponseDto> {
    const email = dto.email || `${dto.provider}_user@riles.app`;
    let user = await this.prisma.user.findUnique({
      where: { email },
    });

    const providerEnum =
      dto.provider === "apple"
        ? AuthProvider.APPLE
        : dto.provider === "google"
          ? AuthProvider.GOOGLE
          : AuthProvider.EMAIL;

    if (!user) {
      const name =
        dto.name ||
        (dto.provider === "apple" ? "Marius (Apple)" : "Marius (Google)");
      const initials = name.slice(0, 2).toUpperCase();

      user = await this.prisma.user.create({
        data: {
          email,
          name,
          initials,
          authProvider: providerEnum,
          planType: PlanType.PRO,
        },
      });
    }

    const payload = { sub: user.id, email: user.email };
    const accessToken = this.jwtService.sign(payload);

    return {
      accessToken,
      userId: user.id,
      email: user.email,
      name: user.name,
    };
  }

  async register(dto: RegisterDto): Promise<AuthResponseDto> {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existing) {
      return this.login({ email: dto.email, password: dto.password });
    }

    const initials =
      dto.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2) || "ML";

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        name: dto.name,
        initials,
        planType: PlanType.PRO,
        authProvider: AuthProvider.EMAIL,
      },
    });

    const payload = { sub: user.id, email: user.email };
    const accessToken = this.jwtService.sign(payload);

    return {
      accessToken,
      userId: user.id,
      email: user.email,
      name: user.name,
    };
  }
}
