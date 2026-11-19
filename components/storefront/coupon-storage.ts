"use client";

import { useCallback, useEffect, useState } from "react";

/** What the store remembers about a coupon the shopper chose (typed or from a magic link). */
export type StoredCoupon = { code: string; label: string | null; source: "link" | "manual"; savedAt: number };

const KEY = (workspace: string) => `postbus:coupon:${workspace}`;
const SKIP_AUTO_KEY = (workspace: string) => `postbus:coupon-skip-auto:${workspace}`;
/** Magic-link codes are kept for a week, like a Shopify discount cookie. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const EVENT = "postbus:coupon-change";

function read(workspace: string): StoredCoupon | null {
  try {
    const raw = window.localStorage.getItem(KEY(workspace));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCoupon;
    if (!parsed?.code || Date.now() - parsed.savedAt > TTL_MS) {
      window.localStorage.removeItem(KEY(workspace));
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveStoredCoupon(workspace: string, coupon: Omit<StoredCoupon, "savedAt"> | null) {
  try {
    if (coupon) window.localStorage.setItem(KEY(workspace), JSON.stringify({ ...coupon, savedAt: Date.now() }));
    else window.localStorage.removeItem(KEY(workspace));
  } catch {
    /* private mode: keep it in memory only */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { workspace } }));
}

export function setSkipAutoCoupon(workspace: string, skip: boolean) {
  try {
    if (skip) window.sessionStorage.setItem(SKIP_AUTO_KEY(workspace), "1");
    else window.sessionStorage.removeItem(SKIP_AUTO_KEY(workspace));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { workspace } }));
}

function readSkipAuto(workspace: string) {
  try {
    return window.sessionStorage.getItem(SKIP_AUTO_KEY(workspace)) === "1";
  } catch {
    return false;
  }
}

/**
 * Reads `?discount=CODE` once, validates it with the store, remembers it, and strips it from the
 * address bar so a refresh or a shared screenshot doesn't re-count the link open.
 */
export function useStoreCoupon(workspace: string) {
  const [coupon, setCoupon] = useState<StoredCoupon | null>(null);
  const [skipAuto, setSkipAuto] = useState(false);
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    const sync = () => {
      setCoupon(read(workspace));
      setSkipAuto(readSkipAuto(workspace));
    };
    sync();
    const onChange = (event: Event) => {
      if ((event as CustomEvent<{ workspace: string }>).detail?.workspace === workspace) sync();
    };
    window.addEventListener(EVENT, onChange);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", sync);
    };
  }, [workspace]);

  useEffect(() => {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("discount")?.trim();
    if (!code) return;
    url.searchParams.delete("discount");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    const controller = new AbortController();
    const params = new URLSearchParams({ workspace, coupon: code, source: "link" });
    try {
      // Same key store-app uses for its events, so a link open joins the shopper's session.
      const sessionKey = `postbus-store-session:${workspace}`;
      const session = window.sessionStorage.getItem(sessionKey) || crypto.randomUUID();
      window.sessionStorage.setItem(sessionKey, session);
      params.set("sessionId", session);
    } catch {
      /* ignore */
    }
    void fetch(`/api/v1/public/store/coupon?${params.toString()}`, { signal: controller.signal })
      .then((response) => response.json())
      .then((body: { data?: { valid: boolean; message: string | null; coupon: { code: string; label: string } | null } }) => {
        const data = body.data;
        if (data?.valid && data.coupon) {
          saveStoredCoupon(workspace, { code: data.coupon.code, label: data.coupon.label, source: "link" });
          setNotice({ tone: "success", text: `${data.coupon.code} applied: ${data.coupon.label}. It’s added at checkout.` });
        } else {
          setNotice({ tone: "error", text: data?.message ?? "This coupon code isn’t valid." });
        }
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [workspace]);

  const apply = useCallback((code: string, label: string | null) => saveStoredCoupon(workspace, { code, label, source: "manual" }), [workspace]);
  const clear = useCallback(() => saveStoredCoupon(workspace, null), [workspace]);
  const skipAutomatic = useCallback((skip: boolean) => setSkipAutoCoupon(workspace, skip), [workspace]);

  return { coupon, skipAuto, notice, dismissNotice: () => setNotice(null), apply, clear, skipAutomatic };
}
