import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import * as crypto from "crypto";
import {
  TrainingInteractionLogInput,
  DatalakeRecord,
} from "./dto/datalake.dto";

@Injectable()
export class DataLakeService implements OnModuleInit {
  private readonly logger = new Logger(DataLakeService.name);
  private supabaseClient: SupabaseClient | null = null;
  private readonly bucketName: string;

  constructor(private readonly configService: ConfigService) {
    this.bucketName =
      this.configService.get<string>("DATALAKE_BUCKET_NAME") ||
      "training-datalake";
  }

  onModuleInit() {
    this.initializeSupabase();
  }

  /**
   * Initialise le client Supabase avec la clé service role (admin)
   */
  private initializeSupabase() {
    const supabaseUrl =
      this.configService.get<string>("SUPABASE_URL") ||
      `https://${this.configService.get<string>("SUPABASE_PROJECT_REF")}.supabase.co`;

    const serviceRoleKey =
      this.configService.get<string>("SUPABASE_SERVICE_ROLE_KEY") ||
      this.configService.get<string>("SUPABASE_SECRET_KEY");

    if (!supabaseUrl || !serviceRoleKey) {
      this.logger.warn(
        "⚠️ Variables SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquantes. Le DataLakeService fonctionnera en mode dégradé (logs locaux uniquement).",
      );
      return;
    }

    try {
      this.supabaseClient = createClient(supabaseUrl, serviceRoleKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      });
      this.logger.log(
        `✅ DataLakeService initialisé avec succès (Bucket cible : "${this.bucketName}").`,
      );
    } catch (err: any) {
      this.logger.error(
        `❌ Échec d'initialisation du client Supabase pour DataLake: ${err?.message}`,
        err?.stack,
      );
    }
  }

  /**
   * Anonymise un identifiant utilisateur via SHA-256 tronqué à 16 caractères hexadécimaux
   */
  public anonymizeUserId(userId: string): string {
    if (!userId) {
      return "anonymous_user";
    }
    return crypto
      .createHash("sha256")
      .update(userId)
      .digest("hex")
      .slice(0, 16);
  }

  /**
   * Génère le chemin partitionné par date pour Supabase Storage :
   * raw/year=YYYY/MM/DD/interaction_[timestamp]_[random].jsonl
   */
  public generatePartitionedPath(date: Date = new Date()): string {
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");

    const timestamp = date.getTime();
    const randomHex = crypto.randomBytes(4).toString("hex");

    return `raw/year=${year}/${month}/${day}/interaction_${timestamp}_${randomHex}.jsonl`;
  }

  /**
   * Enregistre une interaction d'entraînement, le contexte de l'athlète et les feedbacks dans le Data Lake.
   * Cette méthode est totalement non bloquante et encapsulée dans un try/catch pour ne jamais impacter
   * la réponse de l'API appelante.
   */
  async logTrainingInteraction(
    data: TrainingInteractionLogInput,
  ): Promise<boolean> {
    try {
      const now = data.timestamp ? new Date(data.timestamp) : new Date();

      const year = now.getUTCFullYear();
      const month = now.getUTCMonth() + 1;
      const day = now.getUTCDate();

      // 1. Anonymisation systématique de l'ID utilisateur
      const anonymousUserId = this.anonymizeUserId(data.userId);

      // 2. Structuration de l'objet pour le Data Lake
      const record: DatalakeRecord = {
        anonymousUserId,
        timestamp: now.toISOString(),
        schemaVersion: "1.0",
        year,
        month,
        day,
        interactionType:
          data.interactionType ||
          data.interaction?.type ||
          "general_interaction",
        interaction: data.interaction || {},
        athleteContext: data.athleteContext || {},
        feedback: data.feedback || {},
        metadata: {
          loggedAt: new Date().toISOString(),
          environment:
            this.configService.get<string>("NODE_ENV") || "development",
          ...(data.metadata || {}),
        },
      };

      // 3. Format JSON Lines (une seule ligne terminée par un saut de ligne)
      const jsonLineContent = JSON.stringify(record) + "\n";

      // 4. Génération de la clé de partitionnement temporel
      const storagePath = this.generatePartitionedPath(now);

      // Si le client Supabase n'est pas configuré, on trace et on sort sans erreur
      if (!this.supabaseClient) {
        this.logger.debug(
          `[DataLake Mock/Offline] Interaction simulée pour anon_user=${anonymousUserId} vers ${storagePath}`,
        );
        return true;
      }

      // 5. Sauvegarde non bloquante dans Supabase Storage
      const { error } = await this.supabaseClient.storage
        .from(this.bucketName)
        .upload(storagePath, Buffer.from(jsonLineContent, "utf-8"), {
          contentType: "application/x-ndjson",
          upsert: false,
        });

      if (error) {
        this.logger.warn(
          `⚠️ Impossible d'écrire l'interaction dans le Data Lake Storage (${this.bucketName}/${storagePath}) : ${error.message}`,
        );
        return false;
      }

      this.logger.debug(
        `📥 Interaction archivée avec succès dans le Data Lake : ${this.bucketName}/${storagePath} (anon_user: ${anonymousUserId})`,
      );
      return true;
    } catch (error: any) {
      // Gestion d'erreur étanche pour ne jamais faire crasher l'API principale
      this.logger.error(
        `❌ Erreur inattendue lors de l'archivage Data Lake : ${error?.message}`,
        error?.stack,
      );
      return false;
    }
  }
}
