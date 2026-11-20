const POSTHOG_DEFAULT_HOST = "https://us.i.posthog.com";

export type PosthogOtlpLogsConfig = {
  url: string;
  headers: {
    "Content-Type": "application/json";
  };
};

export function posthogOtlpLogsUrl(host: string | undefined, token: string): string {
  const base = (host?.trim() || POSTHOG_DEFAULT_HOST).replace(/\/$/, "");
  const url = new URL(`${base}/i/v1/logs`);
  url.searchParams.set("token", token);
  return url.toString();
}

/** Returns null when the project token is missing so we never send unauthenticated logs. */
export function posthogOtlpLogsConfig(env: {
  token: string | undefined;
  host: string | undefined;
}): PosthogOtlpLogsConfig | null {
  const token = env.token?.trim();
  if (!token) return null;
  return {
    url: posthogOtlpLogsUrl(env.host, token),
    headers: {
      "Content-Type": "application/json",
    },
  };
}
