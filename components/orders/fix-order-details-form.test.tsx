import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { FixOrderDetailsForm } from "@/components/orders/fix-order-details-form";

const base = {
  orderNumber: "12345",
  customerName: "John",
  showPhone: false,
  showPin: false,
  stateChoice: false,
  pinUnavailable: false,
  orderHref: "/dashboard/orders/ord-1",
  initialPhone: "12345",
  initialPin: "67312",
  phase: "idle" as const,
  onSave: () => undefined,
};

describe("Fix Order Details form", () => {
  it("shows only the invalid mobile field and one save button", () => {
    const html = renderToStaticMarkup(
      <FixOrderDetailsForm {...base} showPhone phoneError="Enter a valid 10-digit mobile number." />
    );
    expect(html).toContain("Order #12345");
    expect(html).toContain("Customer: John");
    expect(html).toContain("Invalid Mobile Number");
    expect(html).toContain("+91");
    expect(html).toContain("India flag");
    expect(html).toContain("Enter a valid 10-digit mobile number.");
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("Save Changes");
    expect(html).not.toContain("Invalid PIN Code");
    expect(html).not.toContain("Address line");
    expect(html).not.toContain("Book now");
    expect(html.match(/Save Changes/g)).toHaveLength(1);
  });

  it("shows a 10-digit national number after stripping +91", () => {
    const html = renderToStaticMarkup(
      <FixOrderDetailsForm {...base} showPhone initialPhone="+91 98765 43210" />
    );
    expect(html).toContain('value="9876543210"');
    expect(html).toContain("+91");
  });

  it("shows only the PIN field when the mobile number is valid", () => {
    const html = renderToStaticMarkup(
      <FixOrderDetailsForm {...base} showPin pinError="Enter a valid 6-digit PIN code." />
    );
    expect(html).toContain("Invalid PIN Code");
    expect(html).not.toContain("Invalid Mobile Number");
    expect(html).not.toContain("+91");
  });

  it("shows the saved state without booking", () => {
    const html = renderToStaticMarkup(<FixOrderDetailsForm {...base} showPhone phase="success" />);
    expect(html).toContain("Saved Successfully");
    expect(html).toContain("motion-safe:animate-[saved-pop_300ms_ease-out]");
    expect(html).toContain("@keyframes saved-pop");
    expect(html).not.toContain("Book now");
    expect(html).not.toContain("Save Changes");
  });

  it("keeps the save action available after a failure message", () => {
    const html = renderToStaticMarkup(
      <FixOrderDetailsForm {...base} showPin phase="idle" formError="Could not save the address." />
    );
    expect(html).toContain("Could not save the address.");
    expect(html).toContain("Save Changes");
  });
});