import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { AuthService } from "./auth.service";
import { AuthController } from "./auth.controller";
import { SupabaseAuthGuard } from "./guards/supabase-auth.guard";
import { requireJwtSecret } from "./jwt-secret";

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        // Fail closed: boot refuses to continue without a real secret.
        secret: requireJwtSecret((key) => configService.get<string>(key)),
        signOptions: {
          expiresIn: configService.get<string>("JWT_EXPIRATION", "7d"),
        },
      }),
      inject: [ConfigService],
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, SupabaseAuthGuard],
  exports: [AuthService, JwtModule, SupabaseAuthGuard],
})
export class AuthModule {}
