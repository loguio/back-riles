import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { MetricsService } from "../../common/metrics/metrics.service";

@Module({
  controllers: [HealthController],
  providers: [MetricsService],
  exports: [MetricsService],
})
export class HealthModule {}
