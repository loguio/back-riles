import { Injectable, NestMiddleware } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { Request, Response, NextFunction } from "express";
import { MetricsService } from "../metrics/metrics.service";

/**
 * Request context + access log (CD-03).
 *
 * Adds `X-Request-Id`, emits one structured line per request with latency and
 * status, and feeds the in-process metrics registry used by /metrics.
 */
@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(request: Request, response: Response, next: NextFunction): void {
    const startedAt = process.hrtime.bigint();
    const incomingId = request.headers["x-request-id"];
    const requestId = (Array.isArray(incomingId) ? incomingId[0] : incomingId) || randomUUID();
    response.setHeader("X-Request-Id", requestId);
    (request as Request & { requestId?: string }).requestId = requestId;

    response.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      const route = `${request.method} ${request.baseUrl || ""}${request.path}`;
      const status = response.statusCode;

      this.metrics.inc("http_requests_total");
      this.metrics.inc(`http_status_${Math.floor(status / 100)}xx_total`);
      this.metrics.observeLatency("http_request_duration", durationMs);

      const line = JSON.stringify({
        level: status >= 500 ? "error" : status >= 400 ? "warn" : "info",
        requestId,
        route,
        status,
        durationMs: Math.round(durationMs * 100) / 100,
        userAgent: request.headers["user-agent"],
        ts: new Date().toISOString(),
      });
      if (status >= 500) console.error(line);
      else console.log(line);
    });

    next();
  }
}
