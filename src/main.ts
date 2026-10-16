import { NestFactory } from "@nestjs/core";
import { ValidationPipe, Logger } from "@nestjs/common";
import { SwaggerModule, DocumentBuilder } from "@nestjs/swagger";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/http-exception.filter";
import { RequestLoggerMiddleware } from "./common/middleware/request-logger.middleware";
import { MetricsService } from "./common/metrics/metrics.service";

/** Env vars without which a production instance must not boot (CD-07). */
const REQUIRED_IN_PROD = [
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_JWT_SECRET",
  "DATABASE_URL",
];

async function bootstrap() {
  const logger = new Logger("Bootstrap");
  // rawBody: conserve le corps HTTP brut (Buffer) sur req.rawBody, indispensable
  // pour vérifier les signatures HMAC des webhooks (RILES-005) sur le contenu exact.
  const app = await NestFactory.create(AppModule, { rawBody: true });

  const configService = app.get(ConfigService);
  const port = configService.get<number>("PORT", 3000);
  const prefix = configService.get<string>("API_PREFIX", "api/v1");
  const isProd = (configService.get<string>("NODE_ENV") || "development") === "production";

  // Fail fast on missing production configuration: a half-configured instance
  // is worse than a stopped one at 10k-user scale.
  if (isProd) {
    const missing = REQUIRED_IN_PROD.filter((key) => !configService.get<string>(key));
    if (missing.length > 0) {
      logger.error(`Configuration incomplète en production: ${missing.join(", ")}`);
      process.exit(1);
    }
  }

  // Operational routes stay outside the versioned prefix.
  app.setGlobalPrefix(prefix, { exclude: ["health", "health/(.*)", "ready", "metrics"] });

  // Security headers (CD-07). CSP is intentionally absent here because the API
  // serves JSON only; the landing page owns its own CSP on Netlify.
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-site");
    res.removeHeader("X-Powered-By");
    if (isProd) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  // Global CORS
  app.enableCors({
    origin: configService.get<string>("CORS_ORIGIN", "*").split(","),
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS",
    credentials: true,
  });

  // Request context + structured logs + metrics
  const metrics = app.get(MetricsService);
  const requestLogger = new RequestLoggerMiddleware(metrics);
  app.use(requestLogger.use.bind(requestLogger));

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

  // Swagger Documentation Setup (disabled in production unless explicitly enabled)
  if (!isProd || configService.get<string>("SWAGGER_ENABLED") === "true") {
    const swaggerConfig = new DocumentBuilder()
      .setTitle("Riles API - Backend Sport & Santé")
      .setDescription(
        "API REST NestJS pour l'application mobile Riles : Onboarding, Planning des séances, Check-in RPE, Coach IA et Webhooks montres sportives (Strava, Garmin, Apple Health).",
      )
      .setVersion("1.0")
      .addBearerAuth()
      .addTag("Auth", "Authentification et gestion de session")
      .addTag("Onboarding", "Parcours d'onboarding en 5 étapes")
      .addTag("Users & Profile", "Profil coureur, règles de vie & contraintes")
      .addTag("Workouts & Planning", "Calendrier d'entraînement, séances, notes RPE & adaptation")
      .addTag("Coach & AI", "Chat contextuel Coach IA et suggestions d'ajustement")
      .addTag("Webhooks (Sports & Health)", "Ingestion automatique Strava, Garmin, Apple Health")
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup("api/docs", app, document);
  }

  // Graceful shutdown: stop accepting traffic, then let Nest close hooks
  // (Prisma disconnect, in-flight requests) before exiting (CD-07).
  app.enableShutdownHooks();

  const server = await app.listen(port);

  server.headersTimeout = Number(configService.get<string>("SERVER_HEADERS_TIMEOUT_MS", "65000"));
  server.requestTimeout = Number(configService.get<string>("SERVER_REQUEST_TIMEOUT_MS", "60000"));
  server.keepAliveTimeout = Number(configService.get<string>("SERVER_KEEPALIVE_TIMEOUT_MS", "61000"));

  if (isProd && configService.get<string>("TRUST_PROXY") !== "false") {
    // Behind a load balancer / Netlify proxy: use X-Forwarded-For for IP scope.
    app.getHttpAdapter().getInstance().set("trust proxy", 1);
  }

  logger.log(`🚀 Riles Backend is running on: http://localhost:${port}/${prefix}`);
  logger.log(`❤️ Health probe: http://localhost:${port}/health | readiness: /ready`);
  logger.log(`📈 Metrics: http://localhost:${port}/metrics`);
}

bootstrap();
