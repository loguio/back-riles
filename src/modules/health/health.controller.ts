import { Controller, Get, Headers, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Public } from "../../common/decorators/public.decorator";
import { PrismaService } from "../../prisma/prisma.service";
import { MetricsService } from "../../common/metrics/metrics.service";

/**
 * Operational endpoints (CD-01 / CD-04).
 *
 * They live outside the API prefix and are public: load balancers, uptime
 * probes and Prometheus must be able to reach them before any auth exists.
 */
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  /** Liveness: the process answers. Never touches the database. */
  @Public()
  @Get("health")
  health() {
    return { status: "ok", uptime: process.uptime(), ts: new Date().toISOString() };
  }

  /** Readiness: the process can serve traffic (database reachable). */
  @Public()
  @Get("ready")
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException({ status: "degraded", reason: "database unreachable" });
    }
    return { status: "ready", db: "up", ts: new Date().toISOString() };
  }

  /**
   * Metrics.
   *
   * When METRICS_TOKEN is set, scrapers must send
   * `Authorization: Bearer <METRICS_TOKEN>`; otherwise the endpoint is open
   * (fine for a private network or a sidecar scrape).
   */
  @Public()
  @Get("metrics")
  metricsEndpoint(@Headers("authorization") authorization?: string) {
    const expected = this.config.get<string>("METRICS_TOKEN");
    if (expected && authorization !== `Bearer ${expected}`) {
      throw new UnauthorizedException("Invalid metrics token");
    }
    this.metrics.gauge("process_resident_memory_bytes", process.memoryUsage().rss);
    this.metrics.gauge("process_uptime_seconds", Math.floor(process.uptime()));
    return this.metrics.snapshot();
  }
}
