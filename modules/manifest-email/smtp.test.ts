import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { classifySmtpFailure, formatMailbox, sanitizeMailError } from "@/modules/manifest-email/smtp";

describe("manifest smtp outcomes", () => {
  it("formats the platform sender without taking the merchant domain", () => {
    expect(formatMailbox("PostBus Manifest Service", "manifests@postbus.in")).toBe(
      "PostBus Manifest Service <manifests@postbus.in>"
    );
  });

  it("retries connection failures and keeps a timeout after submission unknown", () => {
    expect(classifySmtpFailure({ code: "ECONNREFUSED", message: "connect refused" }, "SUBMITTED").kind).toBe("retry");
    expect(classifySmtpFailure({ code: "ETIMEDOUT", message: "socket timed out" }, "SUBMITTED").kind).toBe("unknown");
    expect(classifySmtpFailure({ responseCode: 450, message: "mailbox busy" }, "SUBMITTED").kind).toBe("retry");
    expect(classifySmtpFailure({ responseCode: 550, message: "user unknown" }, "SUBMITTED").kind).toBe("permanent");
    expect(classifySmtpFailure({ code: "SMTP_NOT_CONFIGURED", message: "missing host" }, "CONNECTING").kind).toBe(
      "permanent"
    );
  });

  it("removes a configured password from error text", () => {
    process.env.MANIFEST_SMTP_PASSWORD = "super-secret-pass";
    expect(sanitizeMailError(new Error("auth failed for super-secret-pass"))).not.toContain("super-secret-pass");
    delete process.env.MANIFEST_SMTP_PASSWORD;
  });

  it("loads nodemailer as a Node import, not a Function require", () => {
    const source = readFileSync("modules/manifest-email/smtp.ts", "utf8");
    expect(source).not.toMatch(/new Function\([\s\S]*require/);
    expect(source).toMatch(/from ["']nodemailer["']/);
  });

  it("retries a missing-require crash instead of treating it as maybe-sent", () => {
    expect(
      classifySmtpFailure(Object.assign(new Error("require is not defined"), { code: "SMTP_ERROR" }), "SUBMITTED").kind
    ).toBe("retry");
  });
});
