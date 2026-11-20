import { percentToBasisPoints, rupeesToPaise } from "@/modules/affiliates/policy";
import { app, inr, str, type PendingAction, type Row } from "./admin-shared";

const name = (partner: Row) => str(app(partner).fullName ?? partner.partner_name, "this partner");

export function statusAction(partner: Row, status: "APPROVED" | "REJECTED" | "SUSPENDED"): PendingAction {
  const current = String(partner.status);
  const copy = {
    APPROVED: current === "PENDING"
      ? { title: `Approve ${name(partner)}`, confirm: "Approve partner", desc: "They get a default referral link straight away and can start creating campaigns." }
      : { title: `Reactivate ${name(partner)}`, confirm: "Reactivate", desc: "Their links start attributing new signups again." },
    REJECTED: { title: `Reject ${name(partner)}`, confirm: "Reject application", desc: "The reason below is shown to the applicant." },
    SUSPENDED: { title: `Suspend ${name(partner)}`, confirm: "Suspend partner", desc: "New attribution stops. Earned history stays untouched. The reason stays in the audit log." },
  }[status];
  return {
    title: copy.title,
    description: copy.desc,
    confirmLabel: copy.confirm,
    danger: status !== "APPROVED",
    path: `actions/${partner.id}`,
    reasonLabel: status === "REJECTED" ? "Reason (shown to applicant)" : "Reason",
    reasonDefault: status === "APPROVED" ? "Application reviewed and approved." : undefined,
    successMessage: `Partner ${status.toLowerCase()}.`,
    build: () => ({ action: "status", status }),
  };
}

export function rateAction(partner: Row, currentBp: number | null): PendingAction {
  return {
    title: `Commission rate for ${name(partner)}`,
    description: "Applies to payments captured from now on. Past commissions keep the rate they were earned at.",
    confirmLabel: "Save rate",
    path: "actions",
    fields: [
      { name: "percent", label: "Commission (%)", inputMode: "decimal", defaultValue: currentBp != null ? String(currentBp / 100) : "20", help: "Share of each net subscription payment." },
      { name: "fixed", label: "Fixed amount per payment (₹, optional)", inputMode: "decimal", required: false, help: "When set, pays this flat amount instead of the percentage (capped at the payment)." },
    ],
    build: (v) => {
      const basisPoints = percentToBasisPoints(v.percent);
      if (basisPoints == null) return "Enter a percentage between 0 and 100, up to two decimals.";
      const fixedPaise = v.fixed ? rupeesToPaise(v.fixed) : null;
      if (v.fixed && fixedPaise == null) return "Enter the fixed amount in rupees, e.g. 250 or 99.50.";
      return { action: "policy", affiliateId: partner.id, linkId: null, basisPoints, fixedPaise };
    },
  };
}

export function adjustmentAction(partner: Row): PendingAction {
  return {
    title: `Adjust balance for ${name(partner)}`,
    description: "Adds a signed ledger entry. Use a negative amount to deduct. Ledger entries can't be edited later.",
    confirmLabel: "Record adjustment",
    danger: true,
    path: `actions/${partner.id}`,
    fields: [{ name: "amount", label: "Amount (₹)", inputMode: "decimal", placeholder: "e.g. 500 or -120.50" }],
    build: (v) => {
      const amountPaise = rupeesToPaise(v.amount, { allowNegative: true });
      if (!amountPaise) return "Enter a non-zero rupee amount.";
      return { action: "adjustment", amountPaise, key: crypto.randomUUID() };
    },
  };
}

export function linkAction(link: Row, enabled: boolean): PendingAction {
  const label = str(link.campaign, "Default link");
  return {
    title: `${enabled ? "Enable" : "Disable"} “${label}”`,
    description: enabled ? "Clicks on this link start attributing signups again." : "Visitors can still open the site, but new signups won't be credited to this link.",
    confirmLabel: enabled ? "Enable link" : "Disable link",
    danger: !enabled,
    path: `actions/${link.id}`,
    build: () => ({ action: "link", enabled }),
  };
}

export type PayoutDecision = "APPROVED" | "PAID" | "REVIEW" | "REJECTED" | "RETURNED";
export function payoutAction(payout: Row, decision: PayoutDecision): PendingAction {
  const amount = inr(payout.amount_paise);
  const copy: Record<PayoutDecision, [string, string, string]> = {
    APPROVED: [`Approve ${amount} payout`, "Approve payout", "Confirms the amount is owed. Mark it paid once the transfer is done."],
    PAID: [`Mark ${amount} as paid`, "Mark as paid", "Only after you've confirmed the transfer independently. Keep uncertain transfers in review."],
    REVIEW: [`Hold ${amount} for review`, "Move to review", "Keeps the amount reserved while you check something."],
    REJECTED: [`Reject ${amount} payout`, "Reject payout", "Releases the reserved amount back to the partner's balance."],
    RETURNED: [`Record ${amount} as returned`, "Mark returned", "Use when a paid transfer bounced back. The amount returns to the partner's balance."],
  };
  const [title, confirm, description] = copy[decision];
  return {
    title,
    description,
    confirmLabel: confirm,
    danger: decision === "REJECTED" || decision === "RETURNED",
    path: `payouts/${payout.id}`,
    fields: decision === "PAID" ? [{ name: "reference", label: "Settlement reference (UTR / UPI ref)" }] : undefined,
    build: (v) => {
      if (decision === "PAID" && !v.reference) return "A settlement reference is required to mark a payout paid.";
      return { action: decision, reference: v.reference ?? "" };
    },
  };
}

export function destinationAction(accountId: string, onReveal: (details: Row) => void): PendingAction {
  return {
    title: "Reveal payout destination",
    description: "Shows the full UPI details for this transfer. Every reveal is written to the audit log.",
    confirmLabel: "Reveal",
    path: `destination/${accountId}`,
    reasonDefault: "Preparing payout transfer.",
    successMessage: "Destination revealed.",
    build: () => ({}),
    onDone: (result) => onReveal((result || {}) as Row),
  };
}
