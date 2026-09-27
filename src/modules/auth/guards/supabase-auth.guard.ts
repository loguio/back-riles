import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import * as jwt from "jsonwebtoken";
import { PrismaService } from "../../../prisma/prisma.service";
import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator";
import { AuthProvider, PlanType, User } from "@prisma/client";

export interface SupabaseJwtPayload {
  sub: string;
  email?: string;
  role?: string;
  aud?: string;
  exp?: number;
  iat?: number;
  user_metadata?: {
    name?: string;
    full_name?: string;
    avatar_url?: string;
    picture?: string;
    [key: string]: any;
  };
  app_metadata?: {
    provider?: string;
    providers?: string[];
    [key: string]: any;
  };
}

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(SupabaseAuthGuard.name);
  private readonly supabaseAdmin: SupabaseClient | null = null;
  private readonly jwtSecret: string;

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.jwtSecret =
      this.configService.get<string>("SUPABASE_JWT_SECRET") ||
      this.configService.get<string>("JWT_SECRET") ||
      "super-secret-riles-jwt-key-2026-change-in-prod";

    const supabaseUrl =
      this.configService.get<string>("SUPABASE_URL") ||
      `https://${this.configService.get<string>("SUPABASE_PROJECT_REF", "bjktawrigqjshmayutac")}.supabase.co`;

    const supabaseKey =
      this.configService.get<string>("SUPABASE_SECRET_KEY") ||
      this.configService.get<string>("SUPABASE_SERVICE_ROLE_KEY") ||
      this.configService.get<string>("SUPABASE_ANON_KEY") ||
      "";

    if (supabaseUrl && supabaseKey) {
      this.supabaseAdmin = createClient(supabaseUrl, supabaseKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      });
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1. Vérification si la route est marquée comme @Public()
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const authHeader =
      request.headers["authorization"] || request.headers["Authorization"];

    // 2. Extraction du token Bearer
    let token: string | null = null;
    if (authHeader && typeof authHeader === "string") {
      const parts = authHeader.split(" ");
      if (parts.length === 2 && parts[0].toLowerCase() === "bearer") {
        token = parts[1];
      }
    }

    // 3. Cas sans token
    if (!token) {
      // En environnement de dev, si x-user-id est passé, on autorise le fallback vers la DB
      const devUserId = request.headers["x-user-id"];
      const isDev =
        this.configService.get<string>("NODE_ENV") === "development";

      if (isDev && devUserId && typeof devUserId === "string") {
        const user = await this.prisma.user.findUnique({
          where: { id: devUserId },
        });
        if (user) {
          request.user = user;
          return true;
        }
      }

      throw new UnauthorizedException(
        "Jeton d'authentification Bearer manquant ou invalide.",
      );
    }

    // 4. Validation cryptographique du JWT Supabase
    let payload: SupabaseJwtPayload | null = null;

    try {
      // Méthode A : Décodage et vérification locale rapide avec le secret JWT
      payload = jwt.verify(token, this.jwtSecret, {
        algorithms: ["HS256"],
      }) as SupabaseJwtPayload;
    } catch (localJwtErr: any) {
      this.logger.debug(
        `Vérification JWT locale échouée (${localJwtErr.message}), tentative via Supabase Auth API...`,
      );

      // Méthode B : Validation en ligne via l'API Supabase Auth
      if (this.supabaseAdmin) {
        const { data, error } = await this.supabaseAdmin.auth.getUser(token);
        if (error || !data.user) {
          throw new UnauthorizedException(
            "Jeton JWT Supabase invalide ou expiré.",
          );
        }

        payload = {
          sub: data.user.id,
          email: data.user.email,
          role: data.user.role,
          aud: data.user.aud,
          user_metadata: data.user.user_metadata,
          app_metadata: data.user.app_metadata,
        };
      } else {
        throw new UnauthorizedException(
          `Validation du jeton Supabase impossible : ${localJwtErr.message}`,
        );
      }
    }

    if (!payload || !payload.sub) {
      throw new UnauthorizedException(
        "Jeton Supabase malformé : identifiant 'sub' introuvable.",
      );
    }

    // 5. Synchronisation & Auto-Provisioning Prisma PostgreSQL
    const prismaUser = await this.findOrCreatePrismaUser(payload);

    // 6. Injection dans l'objet request pour @CurrentUserId() et @CurrentUser()
    request.user = prismaUser;
    request.supabaseUser = payload;

    return true;
  }

  /**
   * Associe ou crée l'utilisateur dans PostgreSQL via Prisma
   */
  private async findOrCreatePrismaUser(
    payload: SupabaseJwtPayload,
  ): Promise<User> {
    const supabaseId = payload.sub;
    const email = payload.email || `${supabaseId}@riles.app`;

    // Recherche de l'utilisateur par ID Supabase ou Email
    let user = await this.prisma.user.findFirst({
      where: {
        OR: [{ id: supabaseId }, { email }],
      },
    });

    if (user) {
      return user;
    }

    // Extraction du nom et des initiales
    const rawName =
      payload.user_metadata?.full_name ||
      payload.user_metadata?.name ||
      (payload.email ? payload.email.split("@")[0] : "Coureur Riles");

    const initials =
      rawName
        .split(" ")
        .map((part) => part[0])
        .join("")
        .toUpperCase()
        .slice(0, 2) || "CR";

    // Détermination du provider
    const providerStr = (
      payload.app_metadata?.provider ||
      payload.app_metadata?.providers?.[0] ||
      ""
    ).toLowerCase();

    let authProvider: AuthProvider = AuthProvider.EMAIL;
    if (providerStr.includes("apple")) {
      authProvider = AuthProvider.APPLE;
    } else if (providerStr.includes("google")) {
      authProvider = AuthProvider.GOOGLE;
    }

    this.logger.log(
      `🆕 Nouvel utilisateur Supabase détecté (${supabaseId} - ${email}). Création automatique dans Prisma...`,
    );

    // Création du profil en base PostgreSQL
    user = await this.prisma.user.create({
      data: {
        id: supabaseId,
        email,
        name: rawName,
        initials,
        planType: PlanType.PRO,
        authProvider,
        readinessScore: 88,
        isOnboardingCompleted: false,
        activeGoalTitle: "Semi-marathon de Paris",
        activeGoalTarget: "Passer sous les 2h",
        activeGoalRaceDate: "17 mars 2025",
        activeGoalWeeksRemaining: 6,
        activeGoalProgressPercentage: 65,
        activeWeeks: 12,
        totalKm: 328.0,
        completedRaces: 4,
        mainGoal: "Me préparer pour mon premier semi-marathon sans me blesser",
        selectedSports: ["running"],
      },
    });

    return user;
  }
}
