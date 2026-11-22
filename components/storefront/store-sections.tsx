"use client";

import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { ArrowUpRight, House, LayoutGrid, MessageCircle, Play, Quote, ShieldCheck, ShoppingBag, Star, Store } from "lucide-react";
import { videoEmbed } from "@/modules/storefront/layout/video";
import type { LayoutSection } from "@/modules/storefront/layout/schema";
import s from "./marketplace.module.css";

/** Store Builder sections that only need their own settings (no cart or catalog state). */

export function SectionHead({ id, title, aside }: { id: string; title: string; aside?: ReactNode }) {
  if (!title) return null;
  return <div className={s.sectionHead}><h2 id={id}>{title}</h2>{aside ? <span>{aside}</span> : null}</div>;
}

export function PromoBannerSection({ section, storeHref }: { section: LayoutSection<"promo_banner">; storeHref: (href: string) => string }) {
  const { title, body, ctaLabel, ctaHref, imageUrl, tone } = section.settings;
  const href = ctaHref ? (ctaHref.startsWith("/") ? storeHref(ctaHref) : ctaHref) : "";
  const external = /^https?:\/\//i.test(href);
  return (
    <section id={`section-${section.id}`} className={`${s.section} ${s.promo}`} data-tone={tone} aria-labelledby={`promo-${section.id}`}>
      <div className={s.promoCopy}>
        <h2 id={`promo-${section.id}`}>{title}</h2>
        {body ? <p>{body}</p> : null}
        {ctaLabel && href ? (
          <a className={s.primary} href={href} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{ctaLabel}</a>
        ) : null}
      </div>
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- merchant-supplied URL; next/image would need every host allow-listed.
        <img className={s.promoImage} src={imageUrl} alt="" loading="lazy" decoding="async" />
      ) : null}
    </section>
  );
}

export function TestimonialsSection({ section }: { section: LayoutSection<"testimonials"> }) {
  const { title, items } = section.settings;
  if (!items.length) return null;
  return (
    <section id={`section-${section.id}`} className={s.section} aria-labelledby={`reviews-${section.id}`}>
      <SectionHead id={`reviews-${section.id}`} title={title} />
      <ul className={s.testimonials}>
        {items.map((item, index) => (
          <li key={`${item.name}-${index}`}>
            <Quote aria-hidden size={18} className={s.quoteMark} />
            <p className={s.stars} aria-label={`Rated ${item.rating} out of 5`}>
              {Array.from({ length: 5 }, (_, i) => <Star key={i} aria-hidden size={14} fill={i < item.rating ? "currentColor" : "none"} />)}
            </p>
            <blockquote>{item.quote}</blockquote>
            <p className={s.reviewer}><strong>{item.name}</strong>{item.location ? <span>{item.location}</span> : null}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function RichTextSection({ section }: { section: LayoutSection<"rich_text"> }) {
  const { title, body } = section.settings;
  if (!title && !body) return null;
  return (
    <section id={`section-${section.id}`} className={`${s.section} ${s.richText}`} aria-label={title || "About us"}>
      {title ? <h2>{title}</h2> : null}
      {body.split(/\n{2,}/).map((paragraph, index) => <p key={index}>{paragraph}</p>)}
    </section>
  );
}

export function TrustBadgesSection({ items, fallback }: { items: Array<{ title: string; body: string }>; fallback: ReactNode }) {
  if (!items.length) return <>{fallback}</>;
  return (
    <ul className={s.promises} aria-label="Why shop here" style={{ "--promise-cols": items.length } as CSSProperties}>
      {items.map((item) => (
        <li key={item.title}><span className={s.promiseIcon}><ShieldCheck size={18} /></span><span><strong>{item.title}</strong>{item.body ? <span>{item.body}</span> : null}</span></li>
      ))}
    </ul>
  );
}

/** Click-to-load embeds: no third-party iframe (or cookies) until the shopper asks to play. */
function VideoCard({ url, caption, vertical = false }: { url: string; caption: string; vertical?: boolean }) {
  const [playing, setPlaying] = useState(false);
  const embed = videoEmbed(url);
  if (!embed) return null;
  return (
    <figure className={s.video}>
      <div className={vertical ? `${s.videoFrame} ${s.videoFrameVertical}` : s.videoFrame}>
        {playing ? (
          <iframe src={`${embed.embedUrl}&autoplay=1`} title={caption || "Product video"} allow="autoplay; encrypted-media; picture-in-picture" allowFullScreen loading="lazy" />
        ) : (
          <button type="button" className={s.videoPoster} onClick={() => setPlaying(true)} aria-label={`Play video${caption ? `: ${caption}` : ""}`}>
            {embed.thumbnailUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- YouTube thumbnail host.
              <img src={embed.thumbnailUrl} alt="" loading="lazy" decoding="async" />
            ) : null}
            <span className={s.playIcon}><Play size={22} fill="currentColor" /></span>
          </button>
        )}
      </div>
      {caption ? <figcaption>{caption}</figcaption> : null}
    </figure>
  );
}

export function VideoShoppingSection({ section, renderProducts, renderChip }: { section: LayoutSection<"video_shopping">; renderProducts: (ids: string[]) => ReactNode; renderChip?: (id: string) => ReactNode }) {
  const videos = section.settings.videos.filter((video) => videoEmbed(video.url));
  if (!videos.length) return null;
  if (section.settings.layout === "reels") {
    return (
      <section id={`section-${section.id}`} className={s.section} aria-labelledby={`video-${section.id}`}>
        <SectionHead id={`video-${section.id}`} title={section.settings.title} />
        <ul className={s.reels}>
          {videos.map((video, index) => (
            <li key={`${video.url}-${index}`} className={s.reel}>
              <VideoCard url={video.url} caption="" vertical />
              {video.caption ? <p className={s.reelCaption}>{video.caption}</p> : null}
              {video.productIds[0] && renderChip ? <div className={s.reelProduct}>{renderChip(video.productIds[0])}</div> : null}
            </li>
          ))}
        </ul>
      </section>
    );
  }
  return (
    <section id={`section-${section.id}`} className={s.section} aria-labelledby={`video-${section.id}`}>
      <SectionHead id={`video-${section.id}`} title={section.settings.title} />
      <div className={s.videoGrid}>
        {videos.map((video, index) => (
          <div key={`${video.url}-${index}`} className={s.videoItem}>
            <VideoCard url={video.url} caption={video.caption} />
            {video.productIds.length ? <div className={s.videoProducts}>{renderProducts(video.productIds)}</div> : null}
          </div>
        ))}
      </div>
    </section>
  );
}

export function WhatsAppFloat({ phone, message, position, storeName }: { phone: string; message: string; position: "left" | "right"; storeName: string }) {
  const href = `https://wa.me/91${phone}?text=${encodeURIComponent(message)}`;
  return (
    <a className={s.whatsappFloat} data-position={position} href={href} target="_blank" rel="noopener noreferrer" aria-label={`Chat with ${storeName} on WhatsApp`}>
      <MessageCircle size={24} aria-hidden />
    </a>
  );
}

export function AnnouncementBar({ text, href, storeHref, marquee = false }: { text: string; href: string; storeHref: (href: string) => string; marquee?: boolean }) {
  if (!text) return null;
  const target = href ? (href.startsWith("/") ? storeHref(href) : href) : "";
  const external = /^https?:\/\//i.test(target) ? { target: "_blank", rel: "noopener noreferrer" } : {};
  const content = target ? <a href={target} {...external}>{text}</a> : <span>{text}</span>;
  if (!marquee) return <div className={s.announcement} role="region" aria-label="Announcement">{content}</div>;
  // The visible copy is read once; the repeats are decorative so screen readers don't hear a loop.
  return (
    <div className={`${s.announcement} ${s.marquee}`} role="region" aria-label="Announcement">
      <span className="sr-only">{content}</span>
      <div className={s.marqueeTrack} aria-hidden>
        {Array.from({ length: 8 }, (_, i) => <span key={i}>{text}</span>)}
      </div>
    </div>
  );
}

/** Image on one half, copy on the other. Uses the live cover image, else a product photo. */
export function HeroSplit({ title, subtitle, ctaLabel, imageUrl, onCta }: { title: string; subtitle: string; ctaLabel: string; imageUrl: string | null; onCta: () => void }) {
  return (
    <section className={s.heroSplit} aria-labelledby="hero-title">
      <div className={s.heroSplitMedia}>
        {imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- cover/product image already optimized at upload.
          <img src={imageUrl} alt="" fetchPriority="high" />
        ) : <span aria-hidden className={s.heroSplitBlank} />}
      </div>
      <div className={s.heroSplitCopy}>
        <h1 id="hero-title">{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
        <button type="button" className={s.primary} onClick={onCta}>{ctaLabel}</button>
      </div>
    </section>
  );
}

/** Oversized headline running behind a centred photo, with a short line and a pill button. */
export function HeroStatement({ title, subtitle, ctaLabel, imageUrl, onCta }: { title: string; subtitle: string; ctaLabel: string; imageUrl: string | null; onCta: () => void }) {
  return (
    <section className={s.heroStatement} aria-labelledby="hero-title">
      <h1 id="hero-title" className={s.heroStatementTitle}>{title}</h1>
      {imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- cover/product image already optimized at upload.
        <img className={s.heroStatementImage} src={imageUrl} alt="" fetchPriority="high" />
      ) : null}
      <div className={s.heroStatementCopy}>
        {subtitle ? <p>{subtitle}</p> : null}
        <button type="button" className={s.primary} onClick={onCta}>{ctaLabel}</button>
      </div>
    </section>
  );
}

function remaining(endsAt: string | null, now: number) {
  const ms = endsAt ? new Date(endsAt).getTime() - now : 0;
  const total = Math.max(0, Math.floor(ms / 1000));
  return { done: total === 0, days: Math.floor(total / 86_400), hours: Math.floor((total % 86_400) / 3600), mins: Math.floor((total % 3600) / 60), secs: total % 60 };
}

export function CountdownSection({ section, storeHref }: { section: LayoutSection<"countdown">; storeHref: (href: string) => string }) {
  const { eyebrow, title, body, endsAt, ctaLabel, ctaHref } = section.settings;
  // Rendered after mount only, so server and client HTML match.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const left = remaining(endsAt, now ?? 0);
  if (!endsAt || (now !== null && left.done)) return null;
  const href = ctaHref ? (ctaHref.startsWith("/") ? storeHref(ctaHref) : ctaHref) : "";
  const cells: Array<[string, number]> = [["Days", left.days], ["Hours", left.hours], ["Mins", left.mins], ["Secs", left.secs]];
  return (
    <section id={`section-${section.id}`} className={`${s.section} ${s.countdown}`} aria-labelledby={`cd-${section.id}`}>
      <div className={s.countdownTitle}>
        {eyebrow ? <p className={s.eyebrow}>{eyebrow}</p> : null}
        <h2 id={`cd-${section.id}`}>{title}</h2>
      </div>
      <div className={s.countdownClock} role="timer" aria-label={now === null ? "Offer timer" : `${left.days} days ${left.hours} hours ${left.mins} minutes left`}>
        {cells.map(([label, value]) => (
          <span key={label}><strong>{now === null ? "--" : String(value).padStart(2, "0")}</strong><small>{label}</small></span>
        ))}
      </div>
      <div className={s.countdownCta}>
        {body ? <p>{body}</p> : null}
        {ctaLabel && href ? <a className={s.primary} href={href}>{ctaLabel}</a> : null}
      </div>
    </section>
  );
}

/** Phone-only floating tab bar. The cart tab mirrors the header cart. */
export function MobileTabBar({ cartCount, onHome, onShop, onCategories, onCart }: { cartCount: number; onHome: () => void; onShop: () => void; onCategories?: () => void; onCart: () => void }) {
  return (
    <nav className={s.tabBar} aria-label="Quick navigation">
      <button type="button" onClick={onHome}><House size={19} aria-hidden /><span>Home</span></button>
      <button type="button" onClick={onShop}><Store size={19} aria-hidden /><span>Shop</span></button>
      {onCategories ? <button type="button" onClick={onCategories}><LayoutGrid size={19} aria-hidden /><span>Categories</span></button> : null}
      <button type="button" onClick={onCart} aria-label={`Cart, ${cartCount} items`}>
        <span className={s.tabIcon}><ShoppingBag size={19} aria-hidden />{cartCount ? <span className={s.tabBadge}>{cartCount}</span> : null}</span>
        <span aria-hidden>Cart</span>
      </button>
    </nav>
  );
}

export function ViewAllPill({ label = "View all", onClick }: { label?: string; onClick: () => void }) {
  return <button type="button" className={s.viewAll} onClick={onClick}>{label}<span aria-hidden><ArrowUpRight size={14} /></span></button>;
}
