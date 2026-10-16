import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis, { type Redis as Ioredis } from "ioredis";
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
  private redis: Ioredis | null = null;
  private readonly redisScript =
    "local key=KEYS[1] local now=tonumber(ARGV[1]) local rpm=tonumber(ARGV[2]) local burst=tonumber(ARGV[3])" +
    " local refill=rpm/60.0 local capacity=refill+burst" +
    " local got=redis.call('GET',key) local tokens local updatedAt" +
    " if not got then tokens=capacity updatedAt=now else local b=cjson.decode(got) tokens=b.tokens updatedAt=b.updatedAt end" +
    " local elapsed=(now-updatedAt)/1000.0 local next=math.min(capacity,tokens+elapsed*refill)" +
    " if next<1 then redis.call('SET',key,cjson.encode({tokens=next,updatedAt=now}),'EX',600) return 0 end" +
    " redis.call('SET',key,cjson.encode({tokens=next-1,updatedAt=now}),'EX',600) return 1";

  constructor(private readonly configService: ConfigService) {
    this.enabled = this.configService.get<string>("RATE_LIMIT_ENABLED", "true") !== "false";
    this.rpm = Number(this.configService.get<string>("RATE_LIMIT_RPM", "120"));
    this.burst = Number(this.configService.get<string>("RATE_LIMIT_BURST", "30"));

    const redisUrl = this.configService.get<string>("REDIS_URL");
    if (redisUrl) {
      try {
        this.redis = new (Redis as any)(redisUrl, { lazyConnect: true, enableOfflineQueue: false });
        this.redis.connect().catch(() => { this.logger.warn("Redis unavailable; falling back to in-memory rate limits"); this.redis = null; });
      } catch {
        this.redis = null;
      }
    }

    // Opportunistic cleanup so a flood of unique IPs cannot grow the map forever.
    const cleanup = setInterval(() => this.cleanup(), 60_000);
    cleanup.unref();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.enabled) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: { id?: string } }>();
    const key = this.clientKey(request);
    const now = Date.now();

    const capacity = this.rpm / 60 + this.burst;
    if (this.redis) {
      try {
        const allowed = (await this.redis.eval(
          this.redisScript, 1, `rl:${key}`, String(now),
          String(this.rpm), String(this.burst),
        )) as number;
        if (allowed !== 1) {
          this.logger.warn(`Rate limit exceeded for ${key} (${this.rpm} rpm, redis)`);
          this.writeHeaders(context, 0, Math.max(1, Math.ceil(60 / this.rpm)), now);
          throw new HttpException(
            { statusCode: HttpStatus.TOO_MANY_REQUESTS, message: "Trop de requêtes, réessaie dans un instant." },
            HttpStatus.TOO_MANY_REQUESTS,
          );
        }
        this.writeHeaders(context, capacity - 1, Math.max(1, Math.ceil(60 / this.rpm)), now);
        return true;
      } catch (error) {
        if (error instanceof HttpException) throw error;
        this.logger.warn(`Redis rate-limit failed, falling back to memory: ${(error as Error).message}`);
        this.redis = null;
      }
    }

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

  private writeHeaders(context: ExecutionContext, remaining: number, resetSeconds: number, _now: number): void {
    const res = context.switchToHttp().getResponse<{ header?: (k: string, v: string) => void }>();
    res.header?.("X-RateLimit-Limit", String(this.rpm));
    res.header?.("X-RateLimit-Remaining", String(Math.max(0, remaining)));
    res.header?.("X-RateLimit-Reset", String(resetSeconds));
    res.header?.("Retry-After", String(Math.max(1, resetSeconds)));
  }

  private cleanup(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [key, bucket] of this.buckets) {
      if (bucket.updatedAt < cutoff) this.buckets.delete(key);
    }
  }
}
