import { NextRequest } from "next/server";
import { AppError, ERROR_CODES } from "@/lib/api/errors";
import { fail, ok } from "@/lib/api/response";
import { logError } from "@/lib/logger";
import { rateLimit } from "@/lib/security/rate-limit";
import { createServerSupabase } from "@/lib/supabase/server";
import { acceptInviteWithNewAccount, acceptNewAccountSchema, lookupInvite } from "@/modules/team/service";

/** Public: what an invite link is for, so the invite page can greet the person before they sign in. */
export async function GET(request: NextRequest) {
  try {
    const ip = request.headers.get("x-forwarded-for") ?? "local";
    if (!rateLimit(`${ip}:auth/invite:get`, 30, 60_000).ok) {
      throw new AppError(ERROR_CODES.RATE_LIMITED, "Too many requests. Try again shortly.");
    }
    const token = request.nextUrl.searchParams.get("token") ?? "";
    return ok(await lookupInvite(token));
  } catch (error) {
    return fail(error);
  }
}

/** Public: a new team member creates their PostBus login from the invite, then is signed in. */
export async function POST(request: NextRequest) {
  try {
    const ip = request.headers.get("x-forwarded-for") ?? "local";
    if (!rateLimit(`${ip}:auth/invite:post`, 8, 60_000).ok) {
      throw new AppError(ERROR_CODES.RATE_LIMITED, "Too many requests. Try again shortly.");
    }
    const body = acceptNewAccountSchema.parse(await request.json().catch(() => ({})));
    const { email } = await acceptInviteWithNewAccount(body);

    const supabase = await createServerSupabase();
    const { error } = await supabase.auth.signInWithPassword({ email, password: body.password });
    if (error) {
      logError("team.invite.signin_failed", { message: error.message });
      return ok({ joined: true, signedIn: false, email });
    }
    return ok({ joined: true, signedIn: true, email });
  } catch (error) {
    return fail(error);
  }
}
