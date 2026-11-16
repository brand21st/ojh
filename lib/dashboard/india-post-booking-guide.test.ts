import { describe, expect, it } from "vitest";
import {
  setIndiaPostBookingGuideHiddenForUser,
  shouldAutoOpenIndiaPostBookingGuide,
} from "@/lib/dashboard/india-post-booking-guide";

const ready = {
  hydrated: true,
  meLoading: false,
  meError: false,
  hiddenAt: null as string | null,
  localHidden: false,
};

describe("shouldAutoOpenIndiaPostBookingGuide", () => {
  it("opens once the session is ready and the user has not hidden it", () => {
    expect(shouldAutoOpenIndiaPostBookingGuide(ready)).toBe(true);
  });

  it("does not flash while the session is loading or failed", () => {
    expect(shouldAutoOpenIndiaPostBookingGuide({ ...ready, hydrated: false })).toBe(false);
    expect(shouldAutoOpenIndiaPostBookingGuide({ ...ready, meLoading: true })).toBe(false);
    expect(shouldAutoOpenIndiaPostBookingGuide({ ...ready, meError: true })).toBe(false);
  });

  it("stays closed after the user chooses not to show it automatically", () => {
    expect(
      shouldAutoOpenIndiaPostBookingGuide({ ...ready, hiddenAt: "2026-11-16T00:00:00.000Z" }),
    ).toBe(false);
    expect(shouldAutoOpenIndiaPostBookingGuide({ ...ready, localHidden: true })).toBe(false);
  });
});

describe("setIndiaPostBookingGuideHiddenForUser", () => {
  it("stamps the profile hide timestamp when the user opts out", async () => {
    const tables: string[] = [];
    const payloads: Record<string, unknown>[] = [];
    const supabase = {
      from(table: string) {
        tables.push(table);
        return {
          update(payload: Record<string, unknown>) {
            payloads.push(payload);
            return {
              eq() {
                return {
                  select() {
                    return {
                      async maybeSingle() {
                        return {
                          data: { india_post_booking_guide_hidden_at: "2026-11-16T05:00:00.000Z" },
                          error: null,
                        };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    };

    const result = await setIndiaPostBookingGuideHiddenForUser(supabase as never, "user-1", true);
    expect(tables).toEqual(["profiles"]);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toEqual({
      india_post_booking_guide_hidden_at: expect.any(String),
    });
    expect(result).toEqual({
      indiaPostBookingGuideHiddenAt: "2026-11-16T05:00:00.000Z",
    });
  });

  it("clears the profile hide timestamp when the user wants the guide again", async () => {
    const payloads: Record<string, unknown>[] = [];
    const supabase = {
      from() {
        return {
          update(payload: Record<string, unknown>) {
            payloads.push(payload);
            return {
              eq() {
                return {
                  select() {
                    return {
                      async maybeSingle() {
                        return { data: { india_post_booking_guide_hidden_at: null }, error: null };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      },
    };

    const result = await setIndiaPostBookingGuideHiddenForUser(supabase as never, "user-1", false);
    expect(payloads[0]).toEqual({ india_post_booking_guide_hidden_at: null });
    expect(result).toEqual({ indiaPostBookingGuideHiddenAt: null });
  });
});
