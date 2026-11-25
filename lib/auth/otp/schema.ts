import { z } from "zod";
import { indiaPostContractualChoiceSchema, indiaPostContractualToBoolean } from "@/lib/auth/register-schema";
import { toIndiaWhatsappE164 } from "@/lib/phone/india-whatsapp";

const phoneSchema = z.string().trim().transform((value, ctx) => {
  try {
    return toIndiaWhatsappE164(value);
  } catch {
    ctx.addIssue({ code: "custom", message: "Enter a 10-digit Indian WhatsApp number." });
    return z.NEVER;
  }
});

const contractualField = z
  .union([z.boolean(), indiaPostContractualChoiceSchema])
  .transform((value) => indiaPostContractualToBoolean(value));

const profileSchema = z.object({
  name: z.string().trim().min(2, "Enter your name.").max(80),
  business_name: z.string().trim().min(2, "Enter your business name.").max(120),
  email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email.")),
  india_post_contractual_customer: contractualField.optional(),
});

export const otpRequestSchema = z.discriminatedUnion("purpose", [
  z.object({
    purpose: z.literal("LOGIN"),
    phone: phoneSchema,
  }),
  z.object({
    purpose: z.literal("SIGNUP"),
    phone: phoneSchema,
    name: z.string().trim().min(2, "Enter your name.").max(80),
    business_name: z.string().trim().min(2, "Enter your business name.").max(120),
    email: z.string().trim().toLowerCase().pipe(z.email("Enter a valid email.")),
    india_post_contractual_customer: contractualField,
  }),
]);

export const otpVerifySchema = z
  .object({
    challenge_id: z.uuid(),
    phone: phoneSchema,
    purpose: z.enum(["LOGIN", "SIGNUP"]),
    otp: z.string().regex(/^\d{6}$/, "Enter the 6-digit code.").optional(),
    profile: profileSchema.optional(),
  })
  .refine((value) => Boolean(value.otp) || Boolean(value.profile), {
    message: "Enter the 6-digit code.",
  });

export function signupFromRequest(value: z.infer<typeof otpRequestSchema>) {
  if (value.purpose !== "SIGNUP") return null;
  return {
    name: value.name,
    businessName: value.business_name,
    email: value.email,
    indiaPostContractualCustomer: value.india_post_contractual_customer,
  };
}

export function signupFromProfile(profile?: z.infer<typeof profileSchema> | null) {
  if (!profile) return null;
  return {
    name: profile.name,
    businessName: profile.business_name,
    email: profile.email,
    indiaPostContractualCustomer: profile.india_post_contractual_customer ?? false,
  };
}
