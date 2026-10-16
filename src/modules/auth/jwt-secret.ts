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
export function validateEnv(config: Record<string, any>): Record<string, any> {
  requireJwtSecret((key) => config[key]);
  return config;
}
