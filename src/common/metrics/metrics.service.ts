import { Injectable } from "@nestjs/common";

export interface MetricsSnapshot {
  counters: Record<string, number>;
  latencyBuckets: Record<string, number>;
  gauges: Record<string, number>;
}

/**
 * In-process metrics registry.
 *
 * This is intentionally dependency-free: a single instance can be scrappped by
 * /metrics, and the values can be forwarded to Prometheus/Grafana/uptime checks
 * later (CD-04). For multi-instance deployments, export the same counters to
 * your APM; the API shape is stable on purpose.
 */
@Injectable()
export class MetricsService {
  private readonly counters = new Map<string, number>();
  private readonly latencyBuckets = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly startedAt = Date.now();

  /** Latency buckets in milliseconds (mirrors Prometheus defaults). */
  private static readonly BUCKETS = [25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

  inc(name: string, value = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }

  gauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  /** Observe a latency sample and increment every bucket it falls into. */
  observeLatency(name: string, ms: number): void {
    for (const bucket of MetricsService.BUCKETS) {
      if (ms <= bucket) {
        const key = `${name}_le_${bucket}ms`;
        this.latencyBuckets.set(key, (this.latencyBuckets.get(key) ?? 0) + 1);
      }
    }
  }

  getCounter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      latencyBuckets: Object.fromEntries(this.latencyBuckets),
      gauges: { ...Object.fromEntries(this.gauges), uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000) },
    };
  }

  /** Prometheus text exposition format. */
  renderPrometheus(): string {
    const lines: string[] = [];
    for (const [key, value] of this.counters) {
      lines.push(`# TYPE riles_${key} counter`, `riles_${key} ${value}`);
    }
    for (const [key, value] of this.latencyBuckets) {
      lines.push(`# TYPE riles_${key} counter`, `riles_${key} ${value}`);
    }
    for (const [key, value] of this.gauges) {
      lines.push(`# TYPE riles_${key} gauge`, `riles_${key} ${value}`);
    }
    lines.push(`# TYPE riles_uptime_seconds gauge`, `riles_uptime_seconds ${Math.floor((Date.now() - this.startedAt) / 1000)}`);
    return lines.join("\n") + "\n";
  }
}
