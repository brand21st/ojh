"use client";

import { useEffect, useRef } from "react";

const FOCUSABLE = ['a[href]', "button:not([disabled])", 'input:not([disabled]):not([type="hidden"])', "select:not([disabled])", "textarea:not([disabled])", "[tabindex]"]
  .map((selector) => `${selector}:not([tabindex="-1"])`)
  .join(", ");

/**
 * Modal focus handling for storefront sheets: focus moves inside on open, Tab cycles
 * within the dialog, Escape closes, and focus returns to the opener on close.
 * `view` re-targets focus when one component swaps between dialog layouts.
 */
export function useDialogFocus<T extends HTMLElement>(onClose: () => void, view?: string) {
  const ref = useRef<T>(null);
  const closeRef = useRef(onClose);
  const openerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (document.activeElement instanceof HTMLElement && !document.activeElement.closest("[role=dialog]")) {
      openerRef.current = document.activeElement;
    }
    return () => {
      const opener = openerRef.current;
      // Defer so a sibling dialog that replaces this one can claim focus first.
      requestAnimationFrame(() => {
        if (opener?.isConnected && !document.querySelector("[role=dialog][aria-modal=true]")) opener.focus({ preventScroll: true });
      });
    };
  }, []);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const visible = () => [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);
    const initial = container.querySelector<HTMLElement>("[data-autofocus]") ?? visible()[0];
    initial?.focus({ preventScroll: true });

    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = visible();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container!.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !container!.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [view]);

  return ref;
}
