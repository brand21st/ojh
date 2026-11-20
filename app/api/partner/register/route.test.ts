import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const signUp = vi.fn();
const signInWithPassword = vi.fn();
const updateUserById = vi.fn();
const settingsSingle = vi.fn();

vi.mock("@/lib/security/rate-limit", () => ({
  rateLimit: () => ({ ok: true, remaining: 4 }),
}));

vi.mock("@/lib/supabase/server", () => ({
  createServerSupabase: async () => ({
    auth: { signUp, signInWithPassword },
  }),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: () => ({
        single: settingsSingle,
      }),
    }),
    auth: { admin: { updateUserById } },
  }),
}));

import { POST, PUT } from "./route";

const body = { name: "Asha Nair", email: "asha@example.com", password: "shipfast1" };

function request(method: string, payload: unknown) {
  return new NextRequest("https://postbus.test/api/partner/register", {
    method,
    headers: { origin: "https://postbus.test", "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("partner register and login", () => {
  beforeEach(() => {
    vi.stubEnv("POSTBUS_AFFILIATES_ENABLED", "true");
    signUp.mockReset();
    signInWithPassword.mockReset();
    updateUserById.mockReset();
    settingsSingle.mockReset();
    settingsSingle.mockResolvedValue({ data: { registration_open: true }, error: null });
    updateUserById.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    signInWithPassword.mockResolvedValue({ data: { session: { access_token: "t" } }, error: null });
  });

  it("rejects a short password before talking to auth", async () => {
    const response = await POST(request("POST", { ...body, password: "short" }));
    expect(response.status).toBe(422);
    expect(signUp).not.toHaveBeenCalled();
  });

  it("confirms the new account when email confirmation would block login", async () => {
    signUp.mockResolvedValue({
      data: { user: { id: "user-1", identities: [{ id: "ident-1" }] }, session: null },
      error: null,
    });

    const response = await POST(request("POST", body));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.canSignIn).toBe(true);
    expect(updateUserById).toHaveBeenCalledWith("user-1", { email_confirm: true });
  });

  it("tells an existing account to sign in instead of pretending a confirm email was sent", async () => {
    signUp.mockResolvedValue({
      data: { user: { id: "user-1", identities: [] }, session: null },
      error: null,
    });

    const response = await POST(request("POST", body));
    const json = await response.json();

    expect(response.status).toBe(409);
    expect(json.message).toMatch(/already exists/i);
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("signs a confirmed partner in", async () => {
    const response = await PUT(request("PUT", { email: body.email, password: body.password }));
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.data.signedIn).toBe(true);
    expect(signInWithPassword).toHaveBeenCalledWith({ email: "asha@example.com", password: "shipfast1" });
  });
});
