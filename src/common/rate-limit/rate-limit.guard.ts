import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * Token-bucket rate limiter (CD-02).
 *
 * Scope: protects every route, including the public ones (auth, waitlist,
 * webhooks) from a single abusive client.
 *
 * LIMITATION: the bucket is in-memory, so it is per-instance. With more than
 * one replica the effective global limit is `limit × replicas`. Moving this to
 * Redis (CD-11) is a drop-in replacement for the store; the decision logic
 * below stays identical.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly logger = new Logger(RateLimitGuard.name);
  private readonly buckets = new Map<string, Bucket>();
  private readonly enabled: boolean;
  private readonly rpm: number;
  private readonly burst: number;

  constructor(private readonly configService: ConfigService) {
    this.enabled = this.configService.get<string>("RATE_LIMIT_ENABLED", "true") !== "false";
    this.rpm = Number(this.configService.get<string>("RATE_LIMIT_RPM", "120"));
    this.burst = Number(this.configService.get<string>("RATE_LIMIT_BURST", "30"));

    // Opportunistic cleanup so a flood of unique IPs cannot grow the map forever.
    const cleanup = setInterval(() => this.cleanup(), 60_000);
    cleanup.unref();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.enabled) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: { id?: string } }>();
    const key = this.clientKey(request);
    const now = Date.now();

    // Refill: burst tokens every minute.
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.rpm / 60 + this.burst, updatedAt: now };
      this.buckets.set(key, bucket);
    } else {
      const elapsedMs = now - bucket.updatedAt;
      const refill = (elapsedMs / 60_000) * this.rpm;
      bucket.tokens = Math.min(this.rpm / 60 + this.burst, bucket.tokens + refill);
      bucket.updatedAt = now;
    }

    const capacity = this.rpm / 60 + this.burst;
    const remaining = Math.max(0, Math.floor(bucket.tokens));
    const resetSeconds = Math.max(1, Math.ceil((1 - (bucket.tokens % 1)) * (60 / this.rpm)));

    if (bucket.tokens < 1) {
      this.logger.warn(`Rate limit exceeded for ${key} (${this.rpm} rpm)`);
      const response = context.switchToHttp().getResponse<{ header?: (k: string, v: string) => void }>();
      response.header?.("X-RateLimit-Limit", String(this.rpm));
      response.header?.("X-RateLimit-Remaining", "0");
      response.header?.("X-RateLimit-Reset", String(resetSeconds));
      response.header?.("Retry-After", String(resetSeconds));
      throw new HttpException(
        { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: "Trop de requêtes, réessaie dans un instant." },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    bucket.tokens -= 1;
    const res = context.switchToHttp().getResponse<{ header?: (k: string, v: string) => void }>();
    res.header?.("X-RateLimit-Limit", String(this.rpm));
    res.header?.("X-RateLimit-Remaining", String(Math.max(0, remaining - 1)));
    res.header?.("X-RateLimit-Reset", String(resetSeconds));
    void capacity;
    return true;
  }

  private clientKey(request: Request & { user?: { id?: string } }): string {
    const userId = request.user?.id;
    if (userId) return `user:${userId}`;
    const forwarded = request.headers?.["x-forwarded-for"];
    const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0]?.trim();
    return `ip:${(ip || request.ip || request.socket?.remoteAddress || "unknown").toString()}`;
  }

  private cleanup(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [key, bucket] of this.buckets) {
      if (bucket.updatedAt < cutoff) this.buckets.delete(key);
    }
  }
}
