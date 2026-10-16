/**
 * Fail-closed resolution of the JWT signing/verification secret.
 *
 * There is deliberately no fallback value: a missing or blank secret is a
 * configuration error that must stop the server at boot, otherwise every
 * request could be authenticated with a forged token.
 */

/** Env vars consulted for the secret, in order of precedence. */
export const JWT_SECRET_ENV_KEYS = [
  "SUPABASE_JWT_SECRET",
  "JWT_SECRET",
] as const;

export class MissingJwtSecretError extends Error {
  readonly name = "MissingJwtSecretError";

  constructor() {
    super(
      "JWT secret is not configured: set SUPABASE_JWT_SECRET (preferred) or " +
        "JWT_SECRET before starting the server. The server fails closed and " +
        "refuses to boot without it. Any default secret shipped by an earlier " +
        "revision must be treated as compromised and rotated.",
    );
    Object.setPrototypeOf(this, MissingJwtSecretError.prototype);
  }
}

/** Reads the first non-blank secret from the given resolver. */
export function readJwtSecret(
  resolve: (key: string) => unknown,
): string | undefined {
  for (const key of JWT_SECRET_ENV_KEYS) {
    const value = resolve(key);
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

/** Returns the secret or throws {@link MissingJwtSecretError}. */
export function requireJwtSecret(resolve: (key: string) => unknown): string {
  const secret = readJwtSecret(resolve);
  if (!secret) {
    throw new MissingJwtSecretError();
  }
  return secret;
}

/**
 * `validate` hook for `ConfigModule.forRoot()`. It runs before any provider is
 * instantiated, so an unconfigured secret aborts `NestFactory.create()` with a
 * clear message instead of letting the app start with no usable auth.
 */
export class MissingConfigError extends Error {
  readonly name = "MissingConfigError";
  readonly missing: string[];

  constructor(missing: string[]) {
    super(
      "Configuration incomplète : variables manquantes — " +
        missing.join(", ") +
        ". Renseignez-les avant de démarrer le serveur.",
    );
    this.missing = missing;
    Object.setPrototypeOf(this, MissingConfigError.prototype);
  }
}

/** Env vars required in production in addition to the JWT secret. */
export const REQUIRED_ENV_IN_PRODUCTION = [
  "SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "DATABASE_URL",
] as const;

export function validateEnv(config: Record<string, any>): Record<string, any> {
  requireJwtSecret((key) => config[key]);

  const isProd =
    String(config.NODE_ENV ?? process.env.NODE_ENV ?? "").toLowerCase() ===
    "production";

  if (isProd) {
    const missing = REQUIRED_ENV_IN_PRODUCTION.filter((key) => {
      const value = config[key];
      return typeof value !== "string" || value.trim().length === 0;
    });
    if (missing.length > 0) {
      throw new MissingConfigError([...missing]);
    }
  }

  return config;
}
