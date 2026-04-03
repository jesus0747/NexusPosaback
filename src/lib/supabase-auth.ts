/**
 * Nexus POS — Supabase Auth Middleware
 *
 * optionalSupabaseAuth  — validates JWT if present; passes through if absent
 * requireSupabaseAuth   — returns 401 if no valid JWT
 *
 * When SUPABASE_SERVICE_ROLE_KEY is not configured the middleware
 * is a no-op, so the admin panel and dev workflows keep working.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Request, Response, NextFunction } from "express";
import { db } from "@workspace/db";
import { nexusUsers } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

// ── Supabase admin client (server-side) ──────────────────────────────────────

const supabaseUrl        = process.env.VITE_SUPABASE_URL        ?? "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

let _adminClient: SupabaseClient | null = null;

function getAdminClient(): SupabaseClient | null {
  if (!supabaseUrl || !supabaseServiceKey) return null;
  if (!_adminClient) {
    _adminClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _adminClient;
}

// Augment Express Request to carry validated user info
declare global {
  namespace Express {
    interface Request {
      supabaseUser?: { id: string; email: string };
      supabaseAccountId?: string;
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function resolveToken(
  req: Request,
): Promise<{ id: string; email: string } | null> {
  const authHeader = req.headers.authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) return null;

  const token  = authHeader.slice(7);
  const client = getAdminClient();
  if (!client) return null;

  const { data, error } = await client.auth.getUser(token);
  if (error || !data.user?.email) return null;

  return { id: data.user.id, email: data.user.email };
}

// ── Middleware ────────────────────────────────────────────────────────────────

/**
 * Validates the JWT if present. Attaches req.supabaseUser when valid.
 * Never blocks the request — use requireSupabaseAuth for enforced routes.
 */
export async function optionalSupabaseAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const user = await resolveToken(req);
    if (user) req.supabaseUser = user;
  } catch (_) {
    // Silent — optional middleware never throws
  }
  next();
}

/**
 * Requires a valid Supabase JWT. Returns 401 if missing or invalid.
 * If Supabase is not configured (missing SERVICE_ROLE_KEY) the check
 * is skipped so development continues unimpeded.
 */
export async function requireSupabaseAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!getAdminClient()) {
    // Supabase not configured in this environment — pass through
    return next();
  }

  try {
    const user = await resolveToken(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    req.supabaseUser = user;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid auth token" });
  }
}

/**
 * When a Supabase user IS authenticated, verify they belong to the
 * requested account (by checking nexus_users by email).
 *
 * When NO JWT is present (admin panel, device calls) the check is skipped.
 * This lets the admin panel share the same routes without a Supabase token.
 *
 * Pass `param` as the route param name holding the accountId (default "accountId").
 */
export function requireAccountAccess(param = "accountId") {
  return async (
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    // No Supabase client → skip (env not configured)
    if (!getAdminClient()) return next();

    const user = req.supabaseUser;
    // No authenticated user → pass through (admin panel / device / public)
    if (!user) return next();

    const accountId = req.params[param];
    if (!accountId) return next();

    try {
      const [row] = await db
        .select({ account_id: nexusUsers.account_id })
        .from(nexusUsers)
        .where(eq(nexusUsers.email, user.email))
        .limit(1);

      if (!row || row.account_id !== accountId) {
        res.status(403).json({ error: "Access denied to this account" });
        return;
      }

      req.supabaseAccountId = accountId;
      next();
    } catch (_err) {
      res.status(500).json({ error: "Auth check failed" });
    }
  };
}
