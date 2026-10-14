import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { ConfigService } from "@nestjs/config";
import { SupabaseClient } from "@supabase/supabase-js";
import * as argon2 from "argon2";
import { PrismaService } from "../../prisma/prisma.service";
import {
  LoginDto,
  SocialAuthDto,
  RegisterDto,
  AuthResponseDto,
} from "./dto/auth.dto";
import { AuthProvider, PlanType, User } from "@prisma/client";
import { SupabaseJwtPayload } from "./supabase-auth.types";
import { createSupabaseAdmin } from "./supabase-admin";

/** Identity extracted from a *verified* provider id-token. */
interface VerifiedIdentity {
  sub: string;
  email?: string;
  name?: string;
  provider: "apple" | "google" | "email";
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly supabaseAdmin: SupabaseClient | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {
    this.supabaseAdmin = createSupabaseAdmin(configService);
  }

  /**
   * Email/password login. The password is always compared against the stored
   * argon2 hash: unknown email, missing hash or wrong password all fail with
   * 401 and no token is issued.
   */
  async login(dto: LoginDto): Promise<AuthResponseDto> {
    const password = dto.password ?? "";
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user?.passwordHash || !password) {
      throw new UnauthorizedException("Invalid email or password.");
    }

    const matches = await argon2
      .verify(user.passwordHash, password)
      .catch(() => false);

    if (!matches) {
      throw new UnauthorizedException("Invalid email or password.");
    }

    return this.issueToken(user);
  }

  /**
   * Social sign-in / sign-up. Identity comes exclusively from a verified
   * provider id-token; the client-supplied email and name are never trusted.
   */
  async socialAuth(dto: SocialAuthDto): Promise<AuthResponseDto> {
    const identity = await this.verifyProviderIdToken(dto);

    let user = await this.prisma.user.findFirst({
      where: {
        OR: identity.email
          ? [{ id: identity.sub }, { email: identity.email }]
          : [{ id: identity.sub }],
      },
    });

    if (!user) {
      const email = identity.email || `${identity.sub}@riles.app`;
      const name = identity.name || email.split("@")[0];
      const initials =
        name
          .split(" ")
          .map((n) => n[0])
          .join("")
          .toUpperCase()
          .slice(0, 2) || "AT";

      user = await this.prisma.user.create({
        data: {
          email,
          name,
          initials,
          authProvider:
            identity.provider === "apple"
              ? AuthProvider.APPLE
              : identity.provider === "google"
                ? AuthProvider.GOOGLE
                : AuthProvider.EMAIL,
          planType: PlanType.PRO,
        },
      });
    }

    return this.issueToken(user);
  }

  /**
   * Account creation. A duplicate email is a 409 (it never logs the caller in
   * as the existing user) and the password is stored as an argon2 hash.
   */
  async register(dto: RegisterDto): Promise<AuthResponseDto> {
    if (!dto.password) {
      throw new BadRequestException(
        "A password is required to create an account.",
      );
    }

    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (existing) {
      throw new ConflictException("An account with this email already exists.");
    }

    const passwordHash = await argon2.hash(dto.password);
    const initials =
      dto.name
        .split(" ")
        .map((n) => n[0])
        .join("")
        .toUpperCase()
        .slice(0, 2) || "ML";

    let user: User;
    try {
      user = await this.prisma.user.create({
        data: {
          email: dto.email,
          name: dto.name,
          initials,
          passwordHash,
          planType: PlanType.PRO,
          authProvider: AuthProvider.EMAIL,
        },
      });
    } catch (err: any) {
      // Concurrent registration of the same email still surfaces as 409.
      if (err?.code === "P2002") {
        throw new ConflictException(
          "An account with this email already exists.",
        );
      }
      throw err;
    }

    return this.issueToken(user);
  }

  /**
   * Verifies the provider id-token of a social sign-in.
   *
   * 1. Tokens signed by this application's Supabase JWT secret are verified
   *    locally (HS256).
   * 2. Google / Apple id-tokens are handed to Supabase Auth, which verifies
   *    them against the provider's JWKS server-side.
   *
   * Anything else is rejected with 401 — no token is ever minted for an
   * unverified identity.
   */
  private async verifyProviderIdToken(
    dto: SocialAuthDto,
  ): Promise<VerifiedIdentity> {
    const idToken = dto.identityToken?.trim();

    if (!idToken) {
      throw new UnauthorizedException(
        "A verified provider id-token is required (identityToken).",
      );
    }

    let localFailure: string | null = null;
    try {
      const payload = this.jwtService.verify<SupabaseJwtPayload>(idToken, {
        algorithms: ["HS256"],
      });

      if (payload?.sub) {
        return {
          sub: payload.sub,
          email: payload.email,
          name: payload.user_metadata?.full_name || payload.user_metadata?.name,
          provider: this.normalizeProvider(
            payload.app_metadata?.provider,
            dto.provider,
          ),
        };
      }
      localFailure = "missing 'sub' claim";
    } catch (err: any) {
      localFailure = err?.message || "invalid signature";
    }

    // Delegated verification for Google / Apple id-tokens.
    if (dto.provider !== "email" && this.supabaseAdmin) {
      try {
        const { data, error } = await this.supabaseAdmin.auth.signInWithIdToken(
          { provider: dto.provider, token: idToken },
        );

        if (!error && data?.user) {
          const supabaseUser = data.user;
          return {
            sub: supabaseUser.id,
            email: supabaseUser.email,
            name:
              supabaseUser.user_metadata?.full_name ||
              supabaseUser.user_metadata?.name,
            provider: dto.provider,
          };
        }

        this.logger.warn(
          `Supabase rejected the ${dto.provider} id-token: ${error?.message}`,
        );
      } catch (err: any) {
        this.logger.warn(
          `Supabase id-token verification failed: ${err?.message}`,
        );
      }
    }

    this.logger.warn(`Rejected unverified social id-token: ${localFailure}`);
    throw new UnauthorizedException("Invalid or unverified provider id-token.");
  }

  private normalizeProvider(
    provider: string | undefined,
    fallback: "apple" | "google" | "email",
  ): "apple" | "google" | "email" {
    if (provider === "apple" || provider === "google" || provider === "email") {
      return provider;
    }
    return fallback;
  }

  private issueToken(user: {
    id: string;
    email: string;
    name: string;
  }): AuthResponseDto {
    const accessToken = this.jwtService.sign({
      sub: user.id,
      email: user.email,
    });

    return {
      accessToken,
      userId: user.id,
      email: user.email,
      name: user.name,
    };
  }
}
