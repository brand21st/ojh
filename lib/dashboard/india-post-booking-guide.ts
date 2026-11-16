import type { SupabaseClient } from "@supabase/supabase-js";
import { AppError, ERROR_CODES } from "@/lib/api/errors";

export const INDIA_POST_BOOKING_GUIDE_STORAGE_PREFIX = "postbus:india-post-guide:hide:";
export const INDIA_POST_BOOKING_GUIDE_LEGACY_STORAGE_KEY = "postbus:india-post-guide:hide";

export function indiaPostBookingGuideStorageKey(userId: string) {
  return `${INDIA_POST_BOOKING_GUIDE_STORAGE_PREFIX}${userId}`;
}

export function hasLocalIndiaPostBookingGuideHidden(userId: string) {
  if (typeof window === "undefined") return false;
  try {
    if (window.localStorage.getItem(indiaPostBookingGuideStorageKey(userId)) === "1") return true;
    return window.localStorage.getItem(INDIA_POST_BOOKING_GUIDE_LEGACY_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setLocalIndiaPostBookingGuideHidden(userId: string, hidden: boolean) {
  if (typeof window === "undefined") return;
  try {
    const key = indiaPostBookingGuideStorageKey(userId);
    if (hidden) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
    window.localStorage.removeItem(INDIA_POST_BOOKING_GUIDE_LEGACY_STORAGE_KEY);
  } catch {
    // private mode should not block the preference
  }
}

export function shouldAutoOpenIndiaPostBookingGuide(input: {
  hydrated: boolean;
  meLoading: boolean;
  meError: boolean;
  hiddenAt?: string | null;
  localHidden: boolean;
}) {
  if (!input.hydrated || input.meLoading || input.meError) return false;
  if (input.hiddenAt || input.localHidden) return false;
  return true;
}

export async function setIndiaPostBookingGuideHiddenForUser(
  supabase: SupabaseClient,
  userId: string,
  hidden: boolean,
) {
  const hiddenAt = hidden ? new Date().toISOString() : null;
  const { data, error } = await supabase
    .from("profiles")
    .update({ india_post_booking_guide_hidden_at: hiddenAt })
    .eq("id", userId)
    .select("india_post_booking_guide_hidden_at")
    .maybeSingle();
  if (error) {
    throw new AppError(ERROR_CODES.PROFILE_UNAVAILABLE, "Could not save booking guide preference.");
  }
  return {
    indiaPostBookingGuideHiddenAt: data?.india_post_booking_guide_hidden_at ?? hiddenAt,
  };
}
