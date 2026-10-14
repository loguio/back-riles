import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  Logger,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { SupabaseClient } from "@supabase/supabase-js";
import * as jwt from "jsonwebtoken";
import { PrismaService } from "../../../prisma/prisma.service";
import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator";
import { AuthProvider, PlanType, User } from "@prisma/client";
import { SupabaseJwtPayload } from "../supabase-auth.types";
import { createSupabaseAdmin } from "../supabase-admin";
import { requireJwtSecret } from "../jwt-secret";

export type { SupabaseJwtPayload };

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  private readonly logger = new Logger(SupabaseAuthGuard.name);
  private readonly supabaseAdmin: SupabaseClient | null;
  private readonly jwtSecret: string;

  constructor(
    private readonly reflector: Reflector,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    // Fail closed: no fallback secret, ever.
    this.jwtSecret = requireJwtSecret((key) =>
      this.configService.get<string>(key),
    );

    this.supabaseAdmin = createSupabaseAdmin(this.configService);
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

    // 3. Aucun jeton Bearer : refusé dans tous les environnements.
    //    Il n'existe plus aucune branche démo/dev ni d'impersonation via
    //    un en-tête X-User-Id (RILES-003).
    if (!token) {
      throw new UnauthorizedException(
        "Jeton d'authentification Bearer manquant ou invalide.",
      );
    }

    // 4. Validation cryptographique du JWT Supabase
    let payload: SupabaseJwtPayload | null = null;

    try {
      // Méthode A : Décodage et vérification locale avec le secret JWT réel
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

      // Aucun décodage sans vérification de signature n'est toléré : un jeton
      // inconnu ou falsifié donne un 401, y compris hors production.
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

    // 5. Synchronisation & Auto-Provisioning Prisma PostgreSQL
    const prismaUser = await this.findOrCreatePrismaUser(payload);

    // 6. Injection dans l'objet request pour @CurrentUserId() et @CurrentUser()
    request.user = prismaUser;
    request.supabaseUser = payload;

    return true;
  }

  /**
   * Associe ou crée l'utilisateur dans PostgreSQL via Prisma avec un profil vierge (aucune donnée en dur)
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

    // Extraction du nom et des initiales à partir des métadonnées d'authentification
    const rawName =
      payload.user_metadata?.full_name ||
      payload.user_metadata?.name ||
      (payload.email ? payload.email.split("@")[0] : "Athlète");

    const initials =
      rawName
        .split(" ")
        .map((part: string) => part[0])
        .join("")
        .toUpperCase()
        .slice(0, 2) || "AT";

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
      `🆕 Nouvel utilisateur Supabase détecté (${supabaseId} - ${email}). Création d'un profil vierge dans Prisma...`,
    );

    // Création du profil vierge en base PostgreSQL (aucun objectif, règle ou appareil en dur)
    user = await this.prisma.user.create({
      data: {
        id: supabaseId,
        email,
        name: rawName,
        initials,
        planType: PlanType.PRO,
        authProvider,
        readinessScore: 80,
        isOnboardingCompleted: false,
        activeGoalTitle: "",
        activeGoalTarget: "",
        activeGoalRaceDate: "",
        activeGoalWeeksRemaining: 0,
        activeGoalProgressPercentage: 0,
        activeWeeks: 0,
        totalKm: 0,
        completedRaces: 0,
        mainGoal: null,
        selectedSports: [],
      },
      include: {
        rules: true,
        syncTokens: true,
      },
    });

    return user;
  }
}
