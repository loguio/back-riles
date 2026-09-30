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
import { AuthProvider, PlanType, User, WorkoutStatus } from "@prisma/client";

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

    const devUserId = request.headers["x-user-id"];
    const isDev = this.configService.get<string>("NODE_ENV") !== "production";

    // 3. Gestion des tokens de démo / développement rapide
    if (
      token &&
      (token.startsWith("dev-token-") ||
        token.startsWith("demo-bearer-token") ||
        token === "demo-token")
    ) {
      const demoId =
        typeof devUserId === "string" && devUserId.length > 0
          ? devUserId
          : "user-01";
      const demoPayload: SupabaseJwtPayload = {
        sub: demoId,
        email: `${demoId}@riles.app`,
        user_metadata: {
          name: "Marius",
          full_name: "Marius",
        },
        app_metadata: {
          provider: "email",
        },
      };

      const prismaUser = await this.findOrCreatePrismaUser(demoPayload);
      request.user = prismaUser;
      request.supabaseUser = demoPayload;
      return true;
    }

    // 4. Cas sans token Bearer (Mode Invité / "Continuer sans compte" / Tests API MVP en dev)
    if (!token) {
      if (isDev) {
        const fallbackUserId =
          typeof devUserId === "string" && devUserId.length > 0
            ? devUserId
            : "user-01";
        const user = await this.prisma.user.findUnique({
          where: { id: fallbackUserId },
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

    // 5. Validation cryptographique du JWT Supabase
    let payload: SupabaseJwtPayload | null = null;

    try {
      // Méthode A : Décodage et vérification locale rapide avec le secret JWT
      payload = jwt.verify(token, this.jwtSecret, {
        algorithms: ["HS256"],
      }) as SupabaseJwtPayload;
    } catch (localJwtErr: any) {
      this.logger.debug(
        `Vérification JWT locale (${localJwtErr.message}), tentative via Supabase Auth API...`,
      );

      // Méthode B : Validation en ligne via l'API Supabase Auth
      if (this.supabaseAdmin) {
        try {
          const { data, error } = await this.supabaseAdmin.auth.getUser(token);
          if (!error && data?.user) {
            payload = {
              sub: data.user.id,
              email: data.user.email,
              role: data.user.role,
              aud: data.user.aud,
              user_metadata: data.user.user_metadata,
              app_metadata: data.user.app_metadata,
            };
          }
        } catch (adminErr: any) {
          this.logger.debug(
            `Supabase Admin validation error: ${adminErr.message}`,
          );
        }
      }

      // Méthode C : Décodage du payload en environnement non-prod si validation externe indisponible
      if (!payload && isDev) {
        try {
          const decoded = jwt.decode(token) as SupabaseJwtPayload | null;
          if (decoded && decoded.sub) {
            this.logger.warn(
              `⚠️ [Dev Fallback] JWT Supabase validé par décodage structurel pour sub=${decoded.sub}`,
            );
            payload = decoded;
          }
        } catch (decodeErr) {
          // Ignorer
        }
      }

      if (!payload) {
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

    // 6. Synchronisation & Auto-Provisioning Prisma PostgreSQL
    const prismaUser = await this.findOrCreatePrismaUser(payload);

    // 7. Injection dans l'objet request pour @CurrentUserId() et @CurrentUser()
    request.user = prismaUser;
    request.supabaseUser = payload;

    return true;
  }

  /**
   * Associe ou crée l'utilisateur dans PostgreSQL via Prisma avec ses données initiales
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
      include: {
        rules: true,
        syncTokens: true,
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
        .map((part: string) => part[0])
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
      `🆕 Nouvel utilisateur Supabase détecté (${supabaseId} - ${email}). Auto-provisioning dans Prisma...`,
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
        rules: {
          create: [
            {
              title: "Jours verrouillés",
              description:
                "Pas d'entraînement le jeudi (famille et récupération active).",
              icon: "calendar-lock",
            },
            {
              title: "Créneaux préférés",
              description:
                "En semaine à 18h30 après le travail, le samedi à 09h00.",
              icon: "clock-outline",
            },
            {
              title: "Constance & Plaisir",
              description:
                "La régularité avant l'intensité pour préserver les mollets.",
              icon: "bullseye-arrow",
            },
            {
              title: "Sommeil & Récupération",
              description:
                "Minimum 7h30 de sommeil avant les sorties de seuil.",
              icon: "sleep",
            },
          ],
        },
        syncTokens: {
          create: [
            {
              provider: "garmin",
              isConnected: true,
              metadata: {
                deviceName: "Garmin Forerunner 265",
                batteryLevel: 84,
              },
            },
            {
              provider: "strava",
              isConnected: true,
              metadata: { athleteName: rawName, premium: true },
            },
          ],
        },
      },
      include: {
        rules: true,
        syncTokens: true,
      },
    });

    return user;
  }
}
