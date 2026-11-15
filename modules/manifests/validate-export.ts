import { wrapIndiaPostAddressLines } from "@/modules/india-post/address-lines";
import { indiaPostMobile } from "@/modules/india-post/endpoints";
import type { ManifestDetail, ManifestSender } from "@/modules/manifests/service";

const PIN = /^[1-9][0-9]{5}$/;

export type ManifestExportIssue = {
  orderNumber: string;
  barcode: string;
  field: string;
  severity: "error" | "warning";
  message: string;
  suggestion: string;
};

function issue(
  line: { orderNumber?: string | null; barcode?: string | null },
  field: string,
  severity: ManifestExportIssue["severity"],
  message: string,
  suggestion: string
): ManifestExportIssue {
  return {
    orderNumber: line.orderNumber ?? "",
    barcode: line.barcode ?? "",
    field,
    severity,
    message,
    suggestion,
  };
}

function checkMobile(
  line: { orderNumber?: string | null; barcode?: string | null },
  field: string,
  phone: string | null | undefined,
  label: string,
  issues: ManifestExportIssue[]
) {
  const raw = (phone ?? "").trim();
  if (!raw) {
    issues.push(
      issue(line, field, "error", `${label} mobile number is missing.`, "Enter a 10-digit Indian mobile starting with 6, 7, 8 or 9.")
    );
    return;
  }
  if (!indiaPostMobile(raw)) {
    issues.push(
      issue(
        line,
        field,
        "error",
        `${label} mobile number is not a valid Indian mobile.`,
        "Use 10 digits starting with 6, 7, 8 or 9. A 91 country code is removed only when the number has 12 digits."
      )
    );
  }
}

function checkPin(
  line: { orderNumber?: string | null; barcode?: string | null },
  field: string,
  pin: string | null | undefined,
  label: string,
  issues: ManifestExportIssue[]
) {
  const raw = (pin ?? "").trim();
  if (!raw) {
    issues.push(issue(line, field, "error", `${label} PIN code is missing.`, "Enter the 6-digit PIN code."));
    return;
  }
  if (!PIN.test(raw)) {
    issues.push(
      issue(line, field, "error", `${label} PIN code must be exactly 6 digits.`, "Remove spaces, decimals and extra characters.")
    );
  }
}

/** Errors block handover Excel and CSV. Warnings are shown and still exported. */
export function validateManifestExport(
  manifest: ManifestDetail,
  sender: Pick<ManifestSender, "name" | "company" | "line1" | "city" | "state" | "pincode" | "phone">
): ManifestExportIssue[] {
  const issues: ManifestExportIssue[] = [];
  const senderLine = { orderNumber: "", barcode: "" };
  if (!(sender.city ?? "").trim()) {
    issues.push(
      issue(
        senderLine,
        "Sender city",
        "error",
        "Sender city is missing.",
        "Update the sender / pickup address in Settings."
      )
    );
  }
  checkMobile(senderLine, "Sender mobile", sender.phone, "Sender", issues);
  checkPin(senderLine, "Sender PIN", sender.pincode, "Sender", issues);
  const bookingGaps: Array<[string, string]> = [];
  if (!(sender.name ?? "").trim()) bookingGaps.push(["Sender name", "Sender Name"]);
  if (!(sender.company ?? "").trim()) bookingGaps.push(["Sender company", "Company Name"]);
  if (!(sender.line1 ?? "").trim()) bookingGaps.push(["Sender address", "Address Line 1"]);
  for (const [field, label] of bookingGaps) {
    issues.push(
      issue(
        senderLine,
        field,
        "warning",
        `${label} is missing for India Post bulk booking.`,
        "Update sender details in Settings. This does not block the handover Excel."
      )
    );
  }
  for (const line of manifest.lines) {
    if (!line.barcode.trim()) {
      issues.push(
        issue(line, "Barcode", "error", "Barcode is missing.", "Book the shipment so it has an India Post barcode before export.")
      );
    }
    checkMobile(line, "Mobile", line.phone, "Receiver", issues);
    checkPin(line, "Pincode", line.pincode, "Receiver", issues);
    if (line.tariffAmount == null) {
      issues.push(
        issue(
          line,
          "Tariff",
          "warning",
          "Tariff is missing.",
          "Leave the cell blank. Do not enter an estimated postage amount."
        )
      );
    }
    const street = wrapIndiaPostAddressLines(line.line1, line.line2, line.line3, line.city);
    if (street.overflow) {
      issues.push(
        issue(
          line,
          "Address line 1",
          "warning",
          "Receiver address does not fit in three lines of 80 characters.",
          "Shorten the address before India Post booking. The handover file still includes the stored lines."
        )
      );
    }
  }
  return issues;
}

export function manifestExportErrorCount(issues: ManifestExportIssue[]) {
  return issues.filter((item) => item.severity === "error").length;
}
