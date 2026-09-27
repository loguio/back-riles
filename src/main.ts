import { NestFactory } from "@nestjs/core";
import { ValidationPipe, Logger } from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/http-exception.filter";

async function bootstrap() {
  const logger = new Logger("Bootstrap");
  const app = await NestFactory.create(AppModule);

  const configService = app.get(ConfigService);
  const port = configService.get<number>("PORT", 3000);
  const prefix = configService.get<string>("API_PREFIX", "api/v1");

  // Global Prefix
  app.setGlobalPrefix(prefix);

  // Global CORS
  app.enableCors({
    origin: true,
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
    credentials: true,
  });

  // Global Pipes & Filters
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
      forbidNonWhitelisted: false,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  // Swagger Documentation Setup
  const swaggerConfig = new DocumentBuilder()
    .setTitle("Riles API - Backend Sport & Santé")
    .setDescription(
      "API REST NestJS pour l’application mobile Riles : Onboarding, Planning des séances, Check-in RPE, Coach IA et Webhooks montres sportives (Strava, Garmin, Apple Health).",
    )
    .setVersion("1.0")
    .addBearerAuth()
    .addTag("Auth", "Authentification et gestion de session")
    .addTag("Onboarding", "Parcours d’onboarding en 5 étapes")
    .addTag("Users & Profile", "Profil coureur, règles de vie & contraintes")
    .addTag(
      "Workouts & Planning",
      "Calendrier d’entraînement, séances, notes RPE & adaptation",
    )
    .addTag(
      "Coach & AI",
      "Chat contextuel Coach IA et suggestions d’ajustement",
    )
    .addTag(
      "Webhooks (Sports & Health)",
      "Ingestion automatique Strava, Garmin, Apple Health",
    )
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("api/docs", app, document);

  await app.listen(port);
  logger.log(
    `🚀 Riles Backend is running on: http://localhost:${port}/${prefix}`,
  );
  logger.log(
    `📚 Swagger Documentation is available at: http://localhost:${port}/api/docs`,
  );
}

bootstrap();
