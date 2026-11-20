/**
 * Turns a YouTube / Vimeo link into a privacy-friendly embed URL the store CSP allows
 * (frame-src youtube-nocookie.com and player.vimeo.com). Anything else is rejected.
 */
export function videoEmbed(raw: string): { provider: "youtube" | "vimeo"; embedUrl: string; thumbnailUrl: string | null } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.replace(/^www\.|^m\./, "");
  let youtubeId: string | null = null;
  if (host === "youtu.be") youtubeId = url.pathname.slice(1).split("/")[0] || null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (url.pathname === "/watch") youtubeId = url.searchParams.get("v");
    else {
      const match = url.pathname.match(/^\/(?:embed|shorts|live)\/([^/?#]+)/);
      youtubeId = match?.[1] ?? null;
    }
  }
  if (youtubeId && /^[A-Za-z0-9_-]{6,20}$/.test(youtubeId)) {
    return {
      provider: "youtube",
      embedUrl: `https://www.youtube-nocookie.com/embed/${youtubeId}?rel=0&modestbranding=1&playsinline=1`,
      thumbnailUrl: `https://i.ytimg.com/vi/${youtubeId}/hqdefault.jpg`,
    };
  }
  if (host === "vimeo.com" || host === "player.vimeo.com") {
    const match = url.pathname.match(/(?:^|\/)(\d{6,12})(?:$|\/)/);
    if (match) return { provider: "vimeo", embedUrl: `https://player.vimeo.com/video/${match[1]}?dnt=1`, thumbnailUrl: null };
  }
  return null;
}
