import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";
import { authCallbackUrl } from "@/lib/auth/urls";
import { ok, fail } from "@/lib/api/response";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { rateLimit } from "@/lib/security/rate-limit";
import { checked, requireAffiliates } from "@/modules/affiliates/service";
import { createAdminClient } from "@/lib/supabase/admin";
import { originsMatch } from "@/lib/security/origin";

const credentialsSchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email()),
    password: z.string().min(8, "Use at least 8 characters.").max(72, "Use 72 characters or fewer."),
  })
  .strict();

const registerSchema = credentialsSchema.extend({
  name: z.string().trim().min(2).max(120),
});

function assertSameOrigin(request: NextRequest) {
  if (!originsMatch(request.headers.get("origin"), request.nextUrl.origin)) {
    throw new AppError(ERROR_CODES.FORBIDDEN, "Invalid origin.");
  }
}

function alreadyRegistered(message: string) {
  return /already|registered|exists/i.test(message);
}

export async function POST(request: NextRequest) {
  try {
    requireAffiliates();
    assertSameOrigin(request);
    if (!rateLimit(`partner-register:${request.headers.get("x-forwarded-for")}`, 5, 60000).ok) {
      throw new AppError(ERROR_CODES.RATE_LIMITED, "Try again shortly.");
    }
    const settings = checked(await createAdminClient().from("affiliate_settings").select("registration_open").single());
    if (!settings?.registration_open) {
      throw new AppError(ERROR_CODES.FORBIDDEN, "Partner registration is closed.");
    }
    const { email, password, name } = registerSchema.parse(await request.json());
    const db = await createServerSupabase();
    const { data, error } = await db.auth.signUp({
      email,
      password,
      options: { data: { full_name: name }, emailRedirectTo: authCallbackUrl("/partner/dashboard") },
    });
    if (error) {
      throw new AppError(
        alreadyRegistered(error.message) ? ERROR_CODES.CONFLICT : ERROR_CODES.VALIDATION_ERROR,
        alreadyRegistered(error.message)
          ? "An account with this email already exists. Sign in instead."
          : error.message
      );
    }
    if (data.user && !data.session && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      throw new AppError(ERROR_CODES.CONFLICT, "An account with this email already exists. Sign in instead.");
    }
    if (data.user?.id && !data.session) {
      const confirmed = await createAdminClient().auth.admin.updateUserById(data.user.id, { email_confirm: true });
      if (confirmed.error) {
        throw new AppError(ERROR_CODES.VALIDATION_ERROR, "Account created. Confirm your email, then sign in.");
      }
    }
    return ok({ canSignIn: true, email });
  } catch (error) {
    return fail(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    requireAffiliates();
    assertSameOrigin(request);
    if (!rateLimit(`partner-login:${request.headers.get("x-forwarded-for")}`, 8, 60000).ok) {
      throw new AppError(ERROR_CODES.RATE_LIMITED, "Try again shortly.");
    }
    const input = credentialsSchema.parse(await request.json());
    const { error } = await (await createServerSupabase()).auth.signInWithPassword(input);
    if (error) {
      return NextResponse.json({ success: false, error: { message: "Unable to sign in." }, message: "Unable to sign in." }, { status: 401 });
    }
    return ok({ signedIn: true });
  } catch (error) {
    return fail(error);
  }
}
