import { ConfigService } from "@nestjs/config";
import { createClient, SupabaseClient } from "@supabase/supabase-js";

/**
 * Read-only view of the Nest ConfigService, so this factory can be handed
 * either the real service or a test double.
 */
export type ConfigReader = Pick<ConfigService, "get">;

/**
 * Builds the Supabase client used for server-side auth operations
 * (e.g. verifying a provider id-token), or returns null when the
 * project is not configured. Callers must treat `null` as "no server-side
 * verification available" and reject the request.
 */
export function createSupabaseAdmin(
  configService: ConfigReader,
): SupabaseClient | null {
  const supabaseUrl =
    configService.get<string>("SUPABASE_URL") ||
    `https://${configService.get<string>(
      "SUPABASE_PROJECT_REF",
      "bjktawrigqjshmayutac",
    )}.supabase.co`;

  const supabaseKey =
    configService.get<string>("SUPABASE_SECRET_KEY") ||
    configService.get<string>("SUPABASE_SERVICE_ROLE_KEY") ||
    configService.get<string>("SUPABASE_ANON_KEY") ||
    "";

  if (!supabaseUrl || !supabaseKey) {
    return null;
  }

  return createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
