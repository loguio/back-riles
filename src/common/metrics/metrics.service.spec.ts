import { Test } from "@nestjs/testing";
import { MetricsService } from "./metrics.service";

describe("MetricsService", () => {
  let service: MetricsService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [MetricsService],
    }).compile();
    service = moduleRef.get(MetricsService);
  });

  it("counts increments per label", () => {
    service.inc("http_requests_total");
    service.inc("http_requests_total", 4);
    expect(service.getCounter("http_requests_total")).toBe(5);
  });

  it("records every latency bucket a sample falls into", () => {
    service.observeLatency("http_request_duration", 80);
    const snap = service.snapshot();
    expect(snap.latencyBuckets["http_request_duration_le_25ms"]).toBeUndefined();
    expect(snap.latencyBuckets["http_request_duration_le_50ms"]).toBeUndefined();
    expect(snap.latencyBuckets["http_request_duration_le_100ms"]).toBe(1);
    expect(snap.latencyBuckets["http_request_duration_le_10000ms"]).toBe(1);
  });

  it("exposes gauges including uptime", () => {
    service.gauge("process_resident_memory_bytes", 1234);
    const snap = service.snapshot();
    expect(snap.gauges.process_resident_memory_bytes).toBe(1234);
    expect(snap.gauges.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it("renders Prometheus exposition text", () => {
    service.inc("llm_calls_total", 2);
    const text = service.renderPrometheus();
    expect(text).toContain("# TYPE riles_llm_calls_total counter");
    expect(text).toContain("riles_llm_calls_total 2");
    expect(text).toContain("riles_uptime_seconds");
  });
});
