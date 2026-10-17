import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { PrismaModule } from "./prisma/prisma.module";
import { AuthModule } from "./modules/auth/auth.module";
import { UsersModule } from "./modules/users/users.module";
import { OnboardingModule } from "./modules/onboarding/onboarding.module";
import { WorkoutsModule } from "./modules/workouts/workouts.module";
import { CommunityModule } from "./modules/community/community.module";
import { CoachModule } from "./modules/coach/coach.module";
import { BillingModule } from "./modules/billing/billing.module";
import { WebhooksModule } from "./modules/webhooks/webhooks.module";
import { DataLakeModule } from "./modules/datalake/datalake.module";
import { LlmModule } from "./modules/llm/llm.module";
import { SupabaseAuthGuard } from "./modules/auth/guards/supabase-auth.guard";
import { validateEnv } from "./modules/auth/jwt-secret";
import { RateLimitGuard } from "./common/rate-limit/rate-limit.guard";
import { HealthModule } from "./modules/health/health.module";
import { WaitlistModule } from "./modules/waitlist/waitlist.module";
import { MetricsService } from "./common/metrics/metrics.service";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: [".env", ".env.local"],
      // Fail closed at boot: aborts before any provider is instantiated when
      // SUPABASE_JWT_SECRET / JWT_SECRET is missing (RILES-002).
      validate: validateEnv,
    }),
    PrismaModule,
    DataLakeModule,
    LlmModule,
    AuthModule,
    UsersModule,
    OnboardingModule,
    WorkoutsModule,
    CommunityModule,
    CoachModule,
    BillingModule,
    WebhooksModule,
    HealthModule,
    WaitlistModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: SupabaseAuthGuard,
    },
    // Rate limiting runs after auth: protected routes already carry an identity,
    // public routes are limited by IP.
    {
      provide: APP_GUARD,
      useClass: RateLimitGuard,
    },
    MetricsService,
  ],
})
export class AppModule {}
