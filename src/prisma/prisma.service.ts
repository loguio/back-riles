import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

/**
 * Accès à PostgreSQL via Prisma — sans repli.
 *
 * RILES-012 : ce service ne contient plus de magasin mémoire ni de proxies
 * « résilients ». Une base injoignable (au démarrage ou pendant une requête)
 * lève une erreur Prisma réelle, que `AllExceptionsFilter` transforme en
 * HTTP 503. Il n'y a donc plus jamais de données fictives renvoyées comme
 * réelles, et plus jamais de perte silencieuse en cas d'indisponibilité.
 *
 * Un test qui a besoin d'une base doit fournir un double explicite
 * (stub/mock injecté), jamais compter sur un repli caché.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  /**
   * Vrai uniquement si la connexion effectuée au démarrage a réussi.
   * Une panne survenant ensuite ne modifie pas ce drapeau : elle se manifeste
   * directement par une erreur Prisma sur la requête (503 côté HTTP).
   */
  public isDbConnected = false;

  async onModuleInit() {
    try {
      await this.$connect();
      this.isDbConnected = true;
      this.logger.log("✅ Connecté à PostgreSQL via Prisma.");
    } catch (err: any) {
      this.isDbConnected = false;
      // RILES-012 : aucun magasin de repli en mémoire. On échoue fort et
      // visiblement : chaque requête lèvera une erreur Prisma réelle,
      // remontée en 503 par le filtre global, plutôt que de répondre avec
      // des données inventées.
      this.logger.error(
        `❌ PostgreSQL injoignable au démarrage (${
          err?.message?.split("\n").pop() || "vérifiez DATABASE_URL"
        }). Aucun repli en mémoire : chaque requête échouera avec un 503 tant que la base sera indisponible.`,
      );
    }
  }

  async onModuleDestroy() {
    try {
      await this.$disconnect();
    } catch {
      // La déconnexion best-effort ne doit jamais masquer l'erreur d'origine.
    }
  }
}
