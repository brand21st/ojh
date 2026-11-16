/** Issues the compact Fix Order Details popup can edit. PIN lookup outages are not customer errors. */

const PHONE_CODES = new Set(["missing_phone", "invalid_phone"]);
const PIN_CODES = new Set(["missing_pincode", "invalid_pincode", "pin_not_found"]);

export type ContactIssue = { code?: string | null; message?: string | null };

export function contactCorrectionFields(issues: ContactIssue[]) {
  return {
    phone: issues.some((issue) => PHONE_CODES.has(String(issue.code ?? ""))),
    pin: issues.some((issue) => PIN_CODES.has(String(issue.code ?? ""))),
    stateChoice: issues.some((issue) => issue.code === "pin_state_mismatch"),
    pinUnavailable: issues.some((issue) => issue.code === "pin_unavailable"),
  };
}

/** True when the merchant can fix the order in the compact popup (or must open the full editor for state). */
export function needsContactCorrection(issues: ContactIssue[]) {
  const fields = contactCorrectionFields(issues);
  return fields.phone || fields.pin || fields.stateChoice;
}
