import { Module } from "@nestjs/common";
import { OnboardingService } from "./onboarding.service";
import { OnboardingController } from "./onboarding.controller";
import { WorkoutsModule } from "../workouts/workouts.module";
import { WebhooksModule } from "../webhooks/webhooks.module";

@Module({
  imports: [WorkoutsModule, WebhooksModule],
  controllers: [OnboardingController],
  providers: [OnboardingService],
  exports: [OnboardingService],
})
export class OnboardingModule {}
