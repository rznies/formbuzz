import { createMiddleware } from 'hono/factory';
import { createRemoteJWKSet, jwtVerify } from 'jose';

type ClerkBindings = {
  CLERK_ISSUER_URL: string;
};

// Module-level JWKS cache: one instance per Worker isolate.
// jose internally caches fetched keys, so repeated requests
// within the same isolate avoid redundant network calls.
let cachedJWKS: ReturnType<typeof createRemoteJWKSet> | null = null;
let cachedIssuer: string | null = null;

function getJWKS(issuerUrl: string) {
  if (cachedJWKS && cachedIssuer === issuerUrl) {
    return cachedJWKS;
  }
  const jwksUrl = new URL('/.well-known/jwks.json', issuerUrl);
  cachedJWKS = createRemoteJWKSet(jwksUrl);
  cachedIssuer = issuerUrl;
  return cachedJWKS;
}

/**
 * Clerk JWT authentication middleware for Hono.
 *
 * Extracts a Bearer token from the Authorization header,
 * verifies its RS256 signature against Clerk's JWKS endpoint,
 * and sets the authenticated user's ID on the context.
 *
 * On failure, returns 401 with a JSON error body.
 */
export const clerkAuth = createMiddleware<{ Bindings: ClerkBindings; Variables: { userId: string } }>(
  async (c, next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader) {
      return c.json({ error: 'Missing Authorization header' }, 401);
    }

    if (!authHeader.startsWith('Bearer ')) {
      return c.json({ error: 'Invalid Authorization format' }, 401);
    }

    const token = authHeader.slice(7);

    if (!token) {
      return c.json({ error: 'Missing token' }, 401);
    }

    const issuerUrl = c.env.CLERK_ISSUER_URL;
    if (!issuerUrl) {
      return c.json({ error: 'Server misconfiguration' }, 500);
    }

    try {
      const JWKS = getJWKS(issuerUrl);
      const { payload } = await jwtVerify(token, JWKS, {
        issuer: issuerUrl,
      });

      const userId = payload.sub;
      if (!userId) {
        return c.json({ error: 'Invalid token: missing subject' }, 401);
      }

      c.set('userId', userId);
      await next();
    } catch (err: any) {
      // jose throws specific error codes for expired, invalid, etc.
      const message =
        err?.code === 'ERR_JWT_EXPIRED'
          ? 'Token expired'
          : 'Invalid token';

      return c.json({ error: message }, 401);
    }
  }
);

// Export the JWKS cache reset for testing purposes
export function _resetJWKSCache() {
  cachedJWKS = null;
  cachedIssuer = null;
}
