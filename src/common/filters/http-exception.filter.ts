import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { Request, Response } from "express";

/**
 * Codes Prisma qui signalent une base de données indisponible
 * (joignabilité, authentification, timeout, connexion closes).
 */
const DB_UNAVAILABLE_PRISMA_CODES: ReadonlySet<string> = new Set([
  "P1000", // échec d'authentification côté base
  "P1001", // impossible d'atteindre le serveur de base
  "P1002", // timeout de la base
  "P1003", // base inexistante
  "P1008", // opérations chronométrées
  "P1017", // le serveur a fermé la connexion
]);

/**
 * RILES-012 : une base hors service doit produire un 503 explicite, jamais un
 * 500 générique et surtout jamais une réponse de substitution.
 */
export function isDatabaseUnavailableError(exception: unknown): boolean {
  if (exception instanceof Prisma.PrismaClientInitializationError) {
    return true;
  }
  if (
    exception instanceof Prisma.PrismaClientKnownRequestError &&
    DB_UNAVAILABLE_PRISMA_CODES.has(exception.code)
  ) {
    return true;
  }
  return false;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const dbUnavailable = isDatabaseUnavailableError(exception);

    const status = dbUnavailable
      ? HttpStatus.SERVICE_UNAVAILABLE
      : exception instanceof HttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const message = dbUnavailable
      ? "Base de données temporairement indisponible. Réessayez plus tard."
      : exception instanceof HttpException
        ? exception.getResponse()
        : "Internal server error";

    this.logger.error(
      `[${request.method}] ${request.url} - Status: ${status} - Error: ${JSON.stringify(message)}`,
      exception instanceof Error ? exception.stack : undefined,
    );

    response.status(status).json({
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      error: typeof message === "string" ? { message } : message,
    });
  }
}
