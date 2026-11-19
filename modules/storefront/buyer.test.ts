import { describe, expect, it } from "vitest";
import {
  forgetBuyerAddress,
  lookupBuyer,
  readDeviceToken,
  rememberBuyer,
  requestCheckoutCode,
  verifyCheckoutCode,
} from "@/modules/storefront/buyer";

type Row = Record<string, unknown>;

/** Just enough of the supabase-js query builder for buyer.ts, backed by arrays. */
function fakeSupabase() {
  const tables: Record<string, Row[]> = {};
  let seq = 0;
  const table = (name: string) => (tables[name] ??= []);
  function from(name: string) {
    const filters: Array<(row: Row) => boolean> = [];
    let op: "select" | "update" | "delete" | "insert" | "upsert" = "select";
    let payload: Row = {};
    let conflict: string[] = [];
    let orderBy: { col: string; asc: boolean } | null = null;
    let lim: number | null = null;
    let from_ = 0;
    let to_: number | null = null;
    let head = false;
    let returnRows = false;
    const run = () => {
      const rows = table(name);
      if (op === "insert" || op === "upsert") {
        const existing = op === "upsert" ? rows.find((row) => conflict.every((col) => row[col] === payload[col])) : undefined;
        if (existing) { Object.assign(existing, payload); return { data: [existing], error: null }; }
        const row = { id: `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`, created_at: new Date(Date.now() + seq).toISOString(), consumed_at: null, attempts: 0, ...payload };
        rows.push(row);
        return { data: [row], error: null };
      }
      let matched = rows.filter((row) => filters.every((f) => f(row)));
      if (op === "update") { matched.forEach((row) => Object.assign(row, payload)); return { data: matched, error: null }; }
      if (op === "delete") { tables[name] = rows.filter((row) => !matched.includes(row)); return { data: matched, error: null }; }
      if (orderBy) {
        const { col, asc } = orderBy;
        matched = [...matched].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1));
      }
      if (to_ != null) matched = matched.slice(from_, to_ + 1);
      if (lim != null) matched = matched.slice(0, lim);
      return { data: head ? null : matched, error: null, count: matched.length };
    };
    const builder = {
      select(_cols?: string, opts?: { head?: boolean }) { if (op === "insert") returnRows = true; head = Boolean(opts?.head); return builder; },
      insert(value: Row) { op = "insert"; payload = value; return builder; },
      upsert(value: Row, opts: { onConflict: string }) { op = "upsert"; payload = value; conflict = opts.onConflict.split(","); return builder; },
      update(value: Row) { op = "update"; payload = value; return builder; },
      delete() { op = "delete"; return builder; },
      eq(col: string, value: unknown) { filters.push((row) => row[col] === value); return builder; },
      in(col: string, values: unknown[]) { filters.push((row) => values.includes(row[col])); return builder; },
      is(col: string, value: unknown) { filters.push((row) => (row[col] ?? null) === value); return builder; },
      gt(col: string, value: string) { filters.push((row) => String(row[col]) > value); return builder; },
      gte(col: string, value: string) { filters.push((row) => String(row[col]) >= value); return builder; },
      order(col: string, opts: { ascending: boolean }) { orderBy = { col, asc: opts.ascending }; return builder; },
      limit(n: number) { lim = n; return builder; },
      range(a: number, b: number) { from_ = a; to_ = b; return builder; },
      maybeSingle() { const r = run(); return Promise.resolve({ data: (r.data as Row[])?.[0] ?? null, error: null }); },
      single() { const r = run(); return Promise.resolve({ data: (r.data as Row[])[0], error: null }); },
      then(resolve: (value: unknown) => void) { void returnRows; resolve(run()); },
    };
    return builder;
  }
  return { client: { from } as never, tables };
}

const org = "org-1";
const phone = "9876543210";
const address = { customerName: "Asha", line1: "House 1", line2: "MG Road", city: "Kochi", state: "Kerala", pincode: "682001" };

describe("fast checkout for returning buyers", () => {
  it("treats an unknown number as a new buyer", async () => {
    const { client } = fakeSupabase();
    expect(await lookupBuyer(client, org, phone, null)).toEqual({ status: "new" });
  });

  it("returns saved addresses only to the browser that saved them", async () => {
    const { client } = fakeSupabase();
    const { token } = await rememberBuyer(client, { organizationId: org, phone: `+91 ${phone}`, address, token: null });
    expect(readDeviceToken(token)).toBe(token);

    const same = await lookupBuyer(client, org, phone, token);
    expect(same.status).toBe("ready");
    expect(same.status === "ready" && same.addresses[0]).toMatchObject({ customerName: "Asha", pincode: "682001" });

    expect(await lookupBuyer(client, org, phone, null)).toEqual({ status: "verify" });
    expect(await lookupBuyer(client, org, phone, "x".repeat(43))).toEqual({ status: "verify" });
    expect(await lookupBuyer(client, "other-org", phone, token)).toEqual({ status: "new" });
  });

  it("verifies a new browser with a WhatsApp code, then trusts it", async () => {
    const { client } = fakeSupabase();
    await rememberBuyer(client, { organizationId: org, phone, address, token: null });
    const sent: string[] = [];
    const t0 = new Date("2026-11-19T10:00:00Z");
    await requestCheckoutCode(client, { organizationId: org, phone, ip: "1.1.1.1", now: t0, send: async (to, code) => { sent.push(`${to}:${code}`); } });
    expect(sent).toHaveLength(1);
    expect(sent[0].startsWith("+919876543210:")).toBe(true);
    const code = sent[0].split(":")[1];

    await expect(verifyCheckoutCode(client, { organizationId: org, phone, code: "000000" === code ? "111111" : "000000", token: null, now: t0 })).rejects.toThrow(/wrong or has expired/);
    const verified = await verifyCheckoutCode(client, { organizationId: org, phone, code, token: null, now: t0 });
    expect(verified.addresses).toHaveLength(1);
    expect((await lookupBuyer(client, org, phone, verified.token)).status).toBe("ready");
    await expect(verifyCheckoutCode(client, { organizationId: org, phone, code, token: null, now: t0 })).rejects.toThrow(/wrong or has expired/);
  });

  it("rejects expired codes and locks after five wrong tries", async () => {
    const { client } = fakeSupabase();
    await rememberBuyer(client, { organizationId: org, phone, address, token: null });
    let code = "";
    const t0 = new Date("2026-11-19T10:00:00Z");
    await requestCheckoutCode(client, { organizationId: org, phone, ip: "1.1.1.1", now: t0, send: async (_to, c) => { code = c; } });
    await expect(verifyCheckoutCode(client, { organizationId: org, phone, code, token: null, now: new Date(t0.getTime() + 6 * 60_000) })).rejects.toThrow(/expired/);

    const t1 = new Date(t0.getTime() + 2 * 60_000);
    await requestCheckoutCode(client, { organizationId: org, phone, ip: "1.1.1.1", now: t1, send: async (_to, c) => { code = c; } });
    const wrong = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < 5; i += 1) await expect(verifyCheckoutCode(client, { organizationId: org, phone, code: wrong, token: null, now: t1 })).rejects.toThrow();
    await expect(verifyCheckoutCode(client, { organizationId: org, phone, code, token: null, now: t1 })).rejects.toThrow(/Too many wrong codes/);
  });

  it("enforces a resend cooldown and does not send codes for numbers without saved details", async () => {
    const { client } = fakeSupabase();
    const send = async () => {};
    await expect(requestCheckoutCode(client, { organizationId: org, phone, ip: "1.1.1.1", send })).rejects.toThrow(/No saved details/);
    await rememberBuyer(client, { organizationId: org, phone, address, token: null });
    const t0 = new Date("2026-11-19T10:00:00Z");
    await requestCheckoutCode(client, { organizationId: org, phone, ip: "1.1.1.1", now: t0, send });
    await expect(requestCheckoutCode(client, { organizationId: org, phone, ip: "1.1.1.1", now: new Date(t0.getTime() + 10_000), send })).rejects.toThrow(/Wait 50 seconds/);
  });

  it("removes the code when WhatsApp delivery fails so the buyer can retry", async () => {
    const { client, tables } = fakeSupabase();
    await rememberBuyer(client, { organizationId: org, phone, address, token: null });
    await expect(requestCheckoutCode(client, { organizationId: org, phone, ip: "1.1.1.1", send: async () => { throw new Error("down"); } })).rejects.toThrow(/Could not send/);
    expect(tables.storefront_checkout_otps ?? []).toHaveLength(0);
  });

  it("updates rather than duplicates the same address and keeps at most five", async () => {
    const { client, tables } = fakeSupabase();
    const { token } = await rememberBuyer(client, { organizationId: org, phone, address, token: null });
    await rememberBuyer(client, { organizationId: org, phone, address: { ...address, line1: " house  1 " }, token });
    expect(tables.storefront_buyer_addresses).toHaveLength(1);
    for (let i = 2; i <= 7; i += 1) {
      await rememberBuyer(client, { organizationId: org, phone, address: { ...address, line1: `House ${i}` }, token, now: new Date(Date.UTC(2026, 10, 19, 10, i)) });
    }
    expect(tables.storefront_buyer_addresses).toHaveLength(5);
  });

  it("lets only a trusted browser forget an address", async () => {
    const { client } = fakeSupabase();
    const { token } = await rememberBuyer(client, { organizationId: org, phone, address, token: null });
    const ready = await lookupBuyer(client, org, phone, token);
    const id = ready.status === "ready" ? ready.addresses[0].id : "";
    await expect(forgetBuyerAddress(client, { organizationId: org, phone, addressId: id, token: null })).rejects.toThrow(/Verify your number/);
    expect((await forgetBuyerAddress(client, { organizationId: org, phone, addressId: id, token })).addresses).toHaveLength(0);
  });
});
