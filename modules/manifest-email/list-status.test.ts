import { describe, expect, it, vi } from "vitest";
import { latestManifestEmailStatuses } from "@/modules/manifest-email/list-status";

function supabaseWith(rows: unknown[] | null, error: { message: string } | null = null) {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    order: vi.fn().mockResolvedValue({ data: rows, error }),
  };
  return { from: vi.fn(() => query) };
}

describe("latestManifestEmailStatuses", () => {
  it("keeps the newest delivery per manifest", async () => {
    const supabase = supabaseWith([
      { id: "new", manifest_id: "m1", status: "SENT", retryable: false, created_at: "2026-11-15T08:00:00Z" },
      { id: "old", manifest_id: "m1", status: "FAILED", retryable: true, created_at: "2026-11-14T08:00:00Z" },
      { id: "other", manifest_id: "m2", status: "QUEUED", retryable: true, created_at: "2026-11-15T07:00:00Z" },
    ]);
    await expect(latestManifestEmailStatuses(supabase as never, "org", ["m1", "m2"])).resolves.toEqual({
      m1: { id: "new", status: "SENT", retryable: false },
      m2: { id: "other", status: "QUEUED", retryable: true },
    });
  });

  it("returns nothing when the table cannot be read", async () => {
    const supabase = supabaseWith(null, { message: "schema cache" });
    await expect(latestManifestEmailStatuses(supabase as never, "org", ["m1"])).resolves.toEqual({});
  });
});
