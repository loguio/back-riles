/**
 * Claims carried by a Supabase-issued access token. The application's own
 * access tokens are signed with the same secret and share this shape.
 */
export interface SupabaseJwtPayload {
  sub: string;
  email?: string;
  role?: string;
  aud?: string;
  exp?: number;
  iat?: number;
  user_metadata?: {
    name?: string;
    full_name?: string;
    avatar_url?: string;
    picture?: string;
    [key: string]: any;
  };
  app_metadata?: {
    provider?: string;
    providers?: string[];
    [key: string]: any;
  };
}
