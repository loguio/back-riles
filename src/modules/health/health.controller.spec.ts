import { Test } from "@nestjs/testing";
import { HealthController } from "./health.controller";
import { MetricsService } from "../../common/metrics/metrics.service";
import { ConfigService } from "@nestjs/config";
import { ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";

describe("HealthController", () => {
  const build = (opts: { dbUp?: boolean; token?: string } = {}) => {
    const prisma = { $queryRaw: jest.fn().mockImplementation(async () => {
      if (opts.dbUp === false) throw new Error("db down");
      return [{ "?column?": 1 }];
    }) };
    const config = { get: (k: string) => (k === "METRICS_TOKEN" ? opts.token : undefined) } as unknown as ConfigService;
    return new HealthController(prisma as never, config, new MetricsService());
  };

  it("health never touches the database", () => {
    const controller = build();
    expect(controller.health().status).toBe("ok");
  });

  it("ready returns ready when the database answers", async () => {
    const controller = build();
    await expect(controller.ready()).resolves.toMatchObject({ status: "ready" });
  });

  it("ready reports degraded when the database is unreachable", async () => {
    const controller = build({ dbUp: false });
    await expect(controller.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it("metrics is open when no token is configured", () => {
    const controller = build();
    expect(controller.metricsEndpoint()).toHaveProperty("counters");
  });

  it("metrics rejects a missing token", () => {
    const controller = build({ token: "secret" });
    expect(() => controller.metricsEndpoint()).toThrow(UnauthorizedException);
  });

  it("metrics accepts the bearer token", () => {
    const controller = build({ token: "secret" });
    expect(controller.metricsEndpoint("Bearer secret")).toHaveProperty("counters");
  });
});
