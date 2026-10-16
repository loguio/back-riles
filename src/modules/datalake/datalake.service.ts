import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  TrainingInteractionLogInput,
  DatalakeRecord,
} from "./dto/datalake.dto";

@Injectable()
export class DataLakeService implements OnModuleInit {
  private readonly logger = new Logger(DataLakeService.name);
  private supabaseClient: SupabaseClient | null = null;
  private readonly bucketName: string;
  private readonly localBaseDir: string;
  private readonly recentRecordsBuffer: DatalakeRecord[] = [];

  constructor(private readonly configService: ConfigService) {
    this.bucketName =
      this.configService.get<string>("DATALAKE_BUCKET_NAME") ||
      "training-datalake";
    this.localBaseDir = path.resolve(
      this.configService.get<string>("DATALAKE_LOCAL_DIR") ||
        path.resolve(process.cwd(), "storage", "datalake"),
    );
  }

  onModuleInit() {
    this.initializeLocalDirectory();
    this.initializeSupabase();
  }

  private getLocalDateParts(date: Date = new Date()): {
    year: number;
    month: number;
    day: number;
    monthStr: string;
    dayStr: string;
  } {
    try {
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Paris",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
      const parts = formatter.formatToParts(date);
      const yStr =
        parts.find((p) => p.type === "year")?.value ||
        String(date.getFullYear());
      const mStr =
        parts.find((p) => p.type === "month")?.value ||
        String(date.getMonth() + 1).padStart(2, "0");
      const dStr =
        parts.find((p) => p.type === "day")?.value ||
        String(date.getDate()).padStart(2, "0");
      return {
        year: Number(yStr),
        month: Number(mStr),
        day: Number(dStr),
        monthStr: mStr,
        dayStr: dStr,
      };
    } catch {
      const y = date.getFullYear();
      const m = date.getMonth() + 1;
      const d = date.getDate();
      return {
        year: y,
        month: m,
        day: d,
        monthStr: String(m).padStart(2, "0"),
        dayStr: String(d).padStart(2, "0"),
      };
    }
  }

  private initializeLocalDirectory() {
    try {
      fs.mkdirSync(this.localBaseDir, { recursive: true });
      const legacyConsolidated = path.join(
        this.localBaseDir,
        "interactions.jsonl",
      );
      if (fs.existsSync(legacyConsolidated)) {
        try {
          fs.unlinkSync(legacyConsolidated);
        } catch {
          // ignore
        }
      }
    } catch (err: any) {
      this.logger.warn(
        `Initialisation du dossier local DataLake ignorée: ${err?.message}`,
      );
    }
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

    if (
      !supabaseUrl ||
      !serviceRoleKey ||
      serviceRoleKey === "your_supabase_service_role_key" ||
      serviceRoleKey === "your_supabase_secret_key"
    ) {
      this.logger.log(
        `✅ DataLakeService actif en stockage JSONL local partitionné (${this.localBaseDir}). Ajoutez SUPABASE_SERVICE_ROLE_KEY dans .env pour répliquer vers le bucket Supabase "${this.bucketName}".`,
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
        `✅ DataLakeService initialisé avec double écriture : Stockage local + Supabase Storage (Bucket : "${this.bucketName}").`,
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
   * Génère le chemin partitionné par date du jour (fuseau Europe/Paris) pour Supabase Storage et le disque local :
   * raw/year=YYYY/MM/DD/interaction_[timestamp]_[random].jsonl
   */
  public generatePartitionedPath(date: Date = new Date()): string {
    const { year, monthStr, dayStr } = this.getLocalDateParts(date);

    const timestamp = date.getTime();
    const randomHex = crypto.randomBytes(4).toString("hex");

    return `raw/year=${year}/${monthStr}/${dayStr}/interaction_${timestamp}_${randomHex}.jsonl`;
  }

  /**
   * Enregistre automatiquement une interaction d'entraînement, le contexte de l'athlète et les feedbacks dans le Data Lake.
   * Totalement non bloquante et encapsulée dans un try/catch pour ne jamais impacter l'API appelante.
   */
  async logTrainingInteraction(
    data: TrainingInteractionLogInput,
  ): Promise<boolean> {
    try {
      const now = data.timestamp ? new Date(data.timestamp) : new Date();

      const { year, month, day } = this.getLocalDateParts(now);

      // 1. Anonymisation systématique de l'ID utilisateur (SHA-256)
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
          storageMode: this.supabaseClient ? "supabase+local" : "local_jsonl",
          ...(data.metadata || {}),
        },
      };

      // Conservation en mémoire (buffer circulaire de 200 entrées)
      this.recentRecordsBuffer.push(record);
      if (this.recentRecordsBuffer.length > 200) {
        this.recentRecordsBuffer.shift();
      }

      // 3. Format JSON Lines (une seule ligne terminée par un saut de ligne)
      const jsonLineContent = JSON.stringify(record) + "\n";

      // 4. Génération de la clé de partitionnement temporel (date du jour Europe/Paris)
      const storagePath = this.generatePartitionedPath(now);

      // 5. Persistance sur disque local uniquement dans le dossier partitionné de la date du jour
      try {
        const fullLocalPartitionedPath = path.join(
          this.localBaseDir,
          ...storagePath.split("/"),
        );
        fs.mkdirSync(path.dirname(fullLocalPartitionedPath), {
          recursive: true,
        });
        fs.writeFileSync(fullLocalPartitionedPath, jsonLineContent, "utf-8");
      } catch (fsErr: any) {
        this.logger.warn(
          `Écriture disque local DataLake ignorée: ${fsErr?.message}`,
        );
      }

      // 6. Si Supabase Storage est configuré avec SUPABASE_SERVICE_ROLE_KEY, réplication cloud
      if (this.supabaseClient) {
        const { error } = await this.supabaseClient.storage
          .from(this.bucketName)
          .upload(storagePath, Buffer.from(jsonLineContent, "utf-8"), {
            contentType: "application/x-ndjson",
            upsert: false,
          });

        if (error) {
          // The local JSONL copy is kept, but the caller MUST know the cloud
          // replication failed: returning true here silently loses data at scale.
          this.logger.error(
            `❌ Réplication cloud Data Lake Storage (${this.bucketName}/${storagePath}) échouée : ${error.message} (copie locale conservée).`,
          );
          return false;
        }
      }

      this.logger.debug(
        `📥 Interaction archivée dans le Data Lake [${record.interactionType}] : ${storagePath} (anon_user: ${anonymousUserId})`,
      );
      return true;
    } catch (error: any) {
      this.logger.error(
        `❌ Erreur inattendue lors de l'archivage Data Lake : ${error?.message}`,
        error?.stack,
      );
      return false;
    }
  }

  /**
   * Retourne les derniers enregistrements du Data Lake pour audit/inspection
   */
  getRecentLogs(limit = 50, interactionType?: string): DatalakeRecord[] {
    let list = [...this.recentRecordsBuffer].reverse();
    if (interactionType) {
      list = list.filter((r) => r.interactionType === interactionType);
    }
    return list.slice(0, Math.max(1, Math.min(limit, 200)));
  }

  /**
   * Retourne les statistiques temps réel du Data Lake
   */
  getStats() {
    const byType: Record<string, number> = {};
    for (const r of this.recentRecordsBuffer) {
      byType[r.interactionType] = (byType[r.interactionType] || 0) + 1;
    }
    return {
      totalBufferedRecords: this.recentRecordsBuffer.length,
      storageMode: this.supabaseClient
        ? "supabase_cloud_and_local"
        : "local_jsonl_partitioned",
      bucketName: this.bucketName,
      localDirectory: this.localBaseDir,
      countsByInteractionType: byType,
      lastRecordAt:
        this.recentRecordsBuffer.length > 0
          ? this.recentRecordsBuffer[this.recentRecordsBuffer.length - 1]
              .timestamp
          : null,
    };
  }
}
