/** AI features the wallet can bill. Client-safe: no server imports. */

export const AI_FEATURES = [
  "data_extraction",
  "address_checker",
  "address_validation",
  "product_copy",
  "cover_copy",
  "prompt_enhance",
  "order_error_explain",
  "image_studio",
  "cover_studio",
] as const;
export type AiFeature = (typeof AI_FEATURES)[number];

export const AI_FEATURE_LABELS: Record<AiFeature, string> = {
  data_extraction: "AI data processing (WhatsApp orders)",
  address_checker: "AI address checker",
  address_validation: "AI address validation",
  product_copy: "AI product copy",
  cover_copy: "AI cover copy",
  prompt_enhance: "AI prompt rewrite",
  order_error_explain: "AI order error explanations",
  image_studio: "AI Image Studio",
  cover_studio: "AI Cover Studio",
};
