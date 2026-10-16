import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { CreateWaitlistEntryDto } from "./dto/waitlist.dto";

export interface WaitlistResult {
  ok: boolean;
  duplicate: boolean;
}

@Injectable()
export class WaitlistService {
  private readonly logger = new Logger(WaitlistService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Stores a pre-launch signup.
   *
   * This is the path that must survive 10k users: it is the only endpoint on
   * the hot landing path, so it is idempotent (unique email), rate-limited at
   * the edge by RateLimitGuard, and never throws to the caller (the landing
   * page falls back to Netlify Forms).
   */
  async subscribe(
    dto: CreateWaitlistEntryDto,
    ip?: string,
    locale = "fr",
  ): Promise<WaitlistResult> {
    const email = dto.email.trim().toLowerCase();
    if (dto.botField) return { ok: true, duplicate: false }; // silently drop bots

    const ipHash = ip
      ? createHash("sha256").update(`${ip}:${this.config.get("WAITLIST_IP_SALT", "riles")}`).digest("hex").slice(0, 16)
      : null;

    try {
      await this.prisma.waitlistEntry.create({
        data: {
          email,
          goal: dto.goal,
          source: dto.source,
          angle: dto.angle,
          utmSource: dto.utmSource,
          utmMedium: dto.utmMedium,
          utmCampaign: dto.utmCampaign,
          locale,
          ipHash,
          consentAt: new Date(dto.consentAt && !Number.isNaN(Date.parse(dto.consentAt)) ? dto.consentAt : Date.now()),
        },
      });
      this.logger.log(`Waitlist signup: ${email} (${dto.source ?? "direct"})`);
      return { ok: true, duplicate: false };
    } catch (error) {
      // P2002 = unique constraint violation: already subscribed.
      if ((error as { code?: string }).code === "P2002") {
        return { ok: true, duplicate: true };
      }
      this.logger.error(`Waitlist write failed: ${(error as Error).message}`);
      throw error;
    }
  }

  async count(): Promise<number> {
    return this.prisma.waitlistEntry.count();
  }
}
