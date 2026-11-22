"use client";

import { Fragment, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Banknote, Grid2X2, Plus, RotateCcw, Search, ShoppingBag, SlidersHorizontal, Truck, Wallet, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { CoverHero } from "./cover-hero";
import { ProductTile, Rail } from "./marketplace-tile";
import { StoreImage } from "./store-image";
import { StorefrontFooter } from "./storefront-footer";
import type { CartLine, StorePayload, StoreProduct, StoreBundle, StoreCategory } from "./store-types";
import { defaultSections, type LayoutSection } from "@/modules/storefront/layout/schema";
import { AnnouncementBar, CountdownSection, HeroSplit, HeroStatement, MobileTabBar, PromoBannerSection, RichTextSection, SectionHead, TestimonialsSection, TrustBadgesSection, VideoShoppingSection, ViewAllPill, WhatsAppFloat } from "./store-sections";
import { formatStorePrice } from "@/modules/storefront/pricing";
import s from "./marketplace.module.css";
import { useStoreHref } from "./store-base";

const DEFAULT_SECTIONS = defaultSections();

export type CatalogFilters = { sort: string; priceMin: string; priceMax: string; inStock: boolean };
export const EMPTY_FILTERS: CatalogFilters = { sort: "newest", priceMin: "", priceMax: "", inStock: false };

function scrollToCatalog() {
  document.getElementById("all-products")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/** Promises the shopper can rely on, derived only from what the catalog actually offers. */
function storePromises(products: StoreProduct[]) {
  const items: Array<{ icon: ReactNode; title: string; body: string }> = [
    { icon: <Truck size={18} />, title: "Delivery across India", body: "Shipped by India Post with tracking" },
  ];
  if (products.some((p) => p.codEnabled)) items.push({ icon: <Banknote size={18} />, title: "Cash on delivery", body: "Pay when your parcel arrives" });
  if (products.some((p) => p.prepaidEnabled)) items.push({ icon: <Wallet size={18} />, title: "Prepaid orders", body: "Pay before dispatch and skip the cash" });
  if (products.some((p) => p.returnAvailable !== false)) items.push({ icon: <RotateCcw size={18} />, title: "Returns accepted", body: "On items marked returnable" });
  return items.slice(0, 4);
}

function StoreIntro({ store, showcase, copy, onBrowseCategories }: { store: StorePayload; showcase: StoreProduct[]; copy?: { title: string; subtitle: string; ctaLabel: string }; onBrowseCategories?: () => void }) {
  const tagline = copy?.subtitle || store.seoDescription || store.footer?.brand?.tagline || `Order directly from ${store.storeName} and get it delivered to your door.`;
  const pictures = showcase.filter((p) => p.imageUrls[0]).slice(0, 3);
  return (
    <section className={s.intro} aria-labelledby="store-title">
      <div className={s.introCopy}>
        {store.logoUrl ? <span className={s.introLogo}><StoreImage src={store.logoUrl} alt="" sizes="64px" preload /></span> : null}
        <h1 id="store-title">{copy?.title || store.storeName}</h1>
        <p>{tagline}</p>
        <div className={s.introActions}>
          <button type="button" className={s.primary} onClick={scrollToCatalog}>{copy?.ctaLabel || "Shop all products"}</button>
          {onBrowseCategories ? <button type="button" className={s.ghost} onClick={onBrowseCategories}>Browse categories</button> : null}
        </div>
      </div>
      {pictures.length ? (
        <div className={s.introShowcase} data-count={pictures.length} aria-hidden>
          {pictures.map((p, i) => <span key={p.id}><StoreImage src={p.imageUrls[0]} alt="" sizes="(max-width: 899px) 30vw, 260px" preload={i === 0} /></span>)}
        </div>
      ) : null}
    </section>
  );
}

export function MarketplaceHome({ store, cart, query, categoryId, searching, filters, onFilters, onQueryChange, onCategoryChange, onOpenCart, onOpenProduct, onAdd, onDecrease, onLoadMore, onBundle, detail, onHome, onCoverEvent }: {
  store: StorePayload; cart: CartLine[]; query: string; categoryId: string; searching: boolean;
  filters: CatalogFilters; onFilters: (filters: CatalogFilters) => void; onQueryChange: (q: string) => void;
  onCategoryChange: (id: string) => void; onOpenCart: () => void; onOpenProduct: (product: StoreProduct) => void;
  onAdd: (product: StoreProduct) => void; onDecrease: (id: string) => void; onLoadMore: () => void; onBundle: (bundle: StoreBundle) => void;
  detail?: ReactNode; onHome?: () => void;
  onCoverEvent?: (type: "COVER_IMPRESSION" | "COVER_CLICK", slideId: string) => void;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const quantities = useMemo(() => new Map(cart.map((line) => [line.product.id, line.quantity])), [cart]);
  const cartCount = cart.reduce((n, l) => n + l.quantity, 0);
  const featured = (store.products.featured ?? store.products.items.filter((p) => store.featuredProductIds.includes(p.id))).slice(0, 10);
  const featuredIds = new Set(featured.map((p) => p.id));
  const best = (store.products.bestSellers ?? []).filter((p) => !featuredIds.has(p.id)).slice(0, 10);
  const filtered = filters.priceMin !== "" || filters.priceMax !== "" || filters.inStock;
  const home = !query && categoryId === "all" && !filtered;
  const promises = useMemo(() => storePromises([...store.products.items, ...featured, ...best]), [store.products.items, featured, best]);
  const storeHref = useStoreHref();
  const productHref = (product: StoreProduct) => (product.slug ? storeHref(`/store/${store.workspace}/products/${product.slug}`) : undefined);
  const card = (product: StoreProduct) => (
    <ProductTile key={product.id} product={product} href={productHref(product)} quantity={quantities.get(product.id) ?? 0} onOpen={() => onOpenProduct(product)} onAdd={() => onAdd(product)} onDecrease={() => onDecrease(product.id)} />
  );
  const resetAll = () => { onFilters(EMPTY_FILTERS); onQueryChange(""); onCategoryChange("all"); };
  const pickCategory = (id: string) => { onCategoryChange(id); requestAnimationFrame(scrollToCatalog); };
  const filterFields = (
    <div className={s.filterFields}>
      <fieldset className={s.priceRange}>
        <legend>Price (₹)</legend>
        <label><span className="sr-only">Minimum price</span><input type="number" min="0" inputMode="numeric" value={filters.priceMin} onChange={(e) => onFilters({ ...filters, priceMin: e.target.value })} placeholder="Min" /></label>
        <span aria-hidden>to</span>
        <label><span className="sr-only">Maximum price</span><input type="number" min="0" inputMode="numeric" value={filters.priceMax} onChange={(e) => onFilters({ ...filters, priceMax: e.target.value })} placeholder="Max" /></label>
      </fieldset>
      <label className={s.check}><input type="checkbox" checked={filters.inStock} onChange={(e) => onFilters({ ...filters, inStock: e.target.checked })} />Hide sold-out items</label>
      {filtered ? <button type="button" className={s.textButton} onClick={() => onFilters({ ...EMPTY_FILTERS, sort: filters.sort })}>Clear filters</button> : null}
    </div>
  );
  const banner = store.slides[0];
  const categoryTiles = store.categories.length >= 2;
  const activeCategory = store.categories.find((c) => c.id === categoryId);
  const layout = store.layout ?? null;
  const sections = layout?.sections ?? DEFAULT_SECTIONS;
  const sectionProducts = (ids: string[]) => {
    const known = new Map([...(store.sectionProducts ? Object.values(store.sectionProducts).flat() : []), ...store.products.items, ...featured, ...best].map((p) => [p.id, p]));
    return ids.map((id) => known.get(id)).filter((p): p is StoreProduct => Boolean(p));
  };
  /** Merchant links: "/x" is relative to the store home, "#x" an anchor, anything else absolute. */
  const linkFor = (href: string) => (href.startsWith("/") ? storeHref(`/store/${store.workspace}${href === "/" ? "" : href}`) : href);
  const promiseList = <ul className={s.promises} aria-label="Why shop here" style={{ "--promise-cols": promises.length } as CSSProperties}>{promises.map((p) => <li key={p.title}><span className={s.promiseIcon}>{p.icon}</span><span><strong>{p.title}</strong><span>{p.body}</span></span></li>)}</ul>;
  const catalogSection = (section: LayoutSection<"catalog">) => (
        <section className={`${s.section} ${s.catalogSection}`} id="all-products" aria-labelledby="catalog-head">
          <div className={s.sectionHead}>
            <h2 id="catalog-head">{query ? `Results for “${query}”` : activeCategory?.name ?? (section.settings.title || "All products")}</h2>
            <span role="status">{searching ? "Updating…" : `${store.products.total} ${store.products.total === 1 ? "product" : "products"}`}</span>
          </div>
          {activeCategory?.description && !query ? <p className={s.categoryLead}>{activeCategory.description}</p> : null}
          <div className={s.catalog}>
            <aside className={s.filters} aria-label="Filter products">{filterFields}</aside>
            <div className="min-w-0">
              <div className={s.toolbar}>
                <button type="button" className={s.filterButton} onClick={() => setFiltersOpen(true)}><SlidersHorizontal size={15} />Filters{filtered ? <span className={s.dot} aria-label="active" /> : null}</button>
                <label className={s.sortLabel}><span>Sort by</span>
                  <select className={s.sort} value={filters.sort} onChange={(e) => onFilters({ ...filters, sort: e.target.value })}>
                    <option value="newest">Newest</option><option value="priceAsc">Price: low to high</option><option value="priceDesc">Price: high to low</option><option value="name">Name: A to Z</option>
                  </select>
                </label>
              </div>
              {store.products.items.length ? <div className={s.grid} aria-busy={searching}>{store.products.items.map(card)}</div> : (
                <div className={s.empty}>
                  <p><strong>{query ? `Nothing matches “${query}”.` : "No products here yet."}</strong></p>
                  <p>{query || filtered || categoryId !== "all" ? "Try a different word or clear your filters." : "Check back soon for new arrivals."}</p>
                  {query || filtered || categoryId !== "all" ? <button type="button" className={s.ghost} onClick={resetAll}>Show all products</button> : null}
                </div>
              )}
              {store.products.total > store.products.items.length ? <div className={s.loadMore}>
                <p>Showing {store.products.items.length} of {store.products.total}</p>
                <button type="button" className={s.ghost} disabled={searching} onClick={onLoadMore}>{searching ? "Loading…" : "Show more products"}</button>
              </div> : null}
            </div>
          </div>
        </section>
  );
  function renderSection(section: LayoutSection): ReactNode {
    switch (section.type) {
      case "hero": {
        const hero = section as LayoutSection<"hero">;
        if (hero.settings.style === "split" || hero.settings.style === "statement") {
          const photo = banner?.imageUrl ?? [...featured, ...best, ...store.products.items].find((p) => p.imageUrls[0])?.imageUrls[0] ?? null;
          const props = {
            title: hero.settings.title || store.storeName,
            subtitle: hero.settings.subtitle || store.seoDescription || `Order directly from ${store.storeName}.`,
            ctaLabel: hero.settings.ctaLabel || "Shop all",
            imageUrl: photo,
            onCta: scrollToCatalog,
          };
          return hero.settings.style === "split" ? <HeroSplit {...props} /> : <HeroStatement {...props} />;
        }
        if (hero.settings.style !== "intro" && banner?.imageUrl) return <>
          <h1 className="sr-only">{store.storeName}</h1>
          <section className={s.banner} aria-label="Store offer"><CoverHero slide={banner} preload onVisible={() => onCoverEvent?.("COVER_IMPRESSION", banner.id)} onCtaClick={() => onCoverEvent?.("COVER_CLICK", banner.id)} /></section>
        </>;
        return <StoreIntro store={store} showcase={[...featured, ...best, ...store.products.items]} copy={hero.settings} onBrowseCategories={categoryTiles ? () => document.getElementById("shop-by-category")?.scrollIntoView({ behavior: "smooth" }) : undefined} />;
      }
      case "trust_badges":
        return <TrustBadgesSection items={(section as LayoutSection<"trust_badges">).settings.items} fallback={promiseList} />;
      case "category_grid": {
        const grid = section as LayoutSection<"category_grid">;
        const { style, title, eyebrow } = grid.settings;
        const picked = grid.settings.categoryIds.length ? grid.settings.categoryIds.map((id) => store.categories.find((c) => c.id === id)).filter((c): c is StoreCategory => Boolean(c)) : store.categories;
        if (grid.settings.categoryIds.length ? !picked.length : !categoryTiles) return null;
        const head = (style === "tiles" || style === "round") && !eyebrow ? <SectionHead id="cat-head" title={title} /> : (
          <div className={s.sectionHead}>
            <div>{eyebrow ? <p className={s.eyebrow}>{eyebrow}</p> : null}{title ? <h2 id="cat-head">{title}</h2> : null}</div>
            {style !== "tiles" && style !== "round" ? <ViewAllPill label="All products" onClick={scrollToCatalog} /> : null}
          </div>
        );
        const art = (c: StoreCategory, sizes: string) => c.imageUrl ? <StoreImage src={c.imageUrl} alt="" sizes={sizes} /> : <span aria-hidden>{c.name.trim().charAt(0).toUpperCase()}</span>;
        if (style === "rows") {
          return <section className={s.section} id="shop-by-category" aria-labelledby={title ? "cat-head" : undefined} aria-label={title ? undefined : "Shop by category"}>
            {head}
            {picked.slice(0, 4).map((c) => {
              const items = store.sectionProducts?.[`${section.id}:${c.id}`] ?? [];
              if (!items.length) return null;
              return <div key={c.id} className={s.categoryRow}>
                <div className={s.categoryRowHead}><h3>{c.name}</h3><button type="button" className={s.textButton} onClick={() => pickCategory(c.id)}>View all</button></div>
                <div className={s.categoryRowBody}>
                  <button type="button" className={s.categoryBanner} onClick={() => pickCategory(c.id)} aria-label={`Shop ${c.name}`}>
                    <span className={s.categoryBannerArt}>{art(c, "(max-width: 599px) 45vw, 240px")}</span>
                    <span className={s.categoryBannerLabel}><strong>{c.name}</strong><span>Shop now →</span></span>
                  </button>
                  {items.slice(0, 7).map(card)}
                </div>
              </div>;
            })}
          </section>;
        }
        return <section className={s.section} id="shop-by-category" aria-labelledby={title ? "cat-head" : undefined} aria-label={title ? undefined : "Shop by category"}>
          {head}
          <div className={style === "mosaic" ? s.categoryMosaic : style === "photo" ? s.categoryPhotos : style === "round" ? s.categoryRound : s.categoryGrid}>{picked.slice(0, style === "mosaic" ? 5 : 12).map((c) => (
            <button type="button" key={c.id} className={style === "tiles" ? s.categoryTile : s.categoryCard} onClick={() => pickCategory(c.id)}>
              <span className={style === "tiles" ? s.categoryArt : s.categoryCardArt}>{art(c, style === "mosaic" ? "(max-width: 599px) 90vw, 560px" : "(max-width: 599px) 45vw, 280px")}</span>
              <span className={style === "tiles" ? s.categoryName : s.categoryCardName}>{c.name}</span>
              {style === "mosaic" ? <span className={s.categoryCardArrow} aria-hidden>↗</span> : null}
            </button>
          ))}</div>
        </section>;
      }
      case "featured_products": {
        const title = (section as LayoutSection<"featured_products">).settings.title;
        return featured.length ? <section className={s.section} aria-labelledby="featured-head"><SectionHead id="featured-head" title={title} /><Rail label={title || "Featured picks"}>{featured.map(card)}</Rail></section> : null;
      }
      case "collection": {
        const collection = section as LayoutSection<"collection">;
        const items = store.sectionProducts?.[section.id] ?? [];
        if (!items.length) return null;
        const category = store.categories.find((c) => c.id === collection.settings.categoryId);
        const label = collection.settings.title || category?.name || "Collection";
        return <section id={`section-${section.id}`} className={s.section} aria-labelledby={`col-${section.id}`}>
          <SectionHead id={`col-${section.id}`} title={label} aside={category ? <button type="button" className={s.textButton} onClick={() => pickCategory(category.id)}>View all</button> : undefined} />
          <Rail label={label}>{items.map(card)}</Rail>
        </section>;
      }
      case "promo_banner":
        return <PromoBannerSection section={section as LayoutSection<"promo_banner">} storeHref={linkFor} />;
      case "video_shopping":
        return <VideoShoppingSection section={section as LayoutSection<"video_shopping">} renderProducts={(ids) => sectionProducts(ids).map(card)} renderChip={(id) => {
          const product = sectionProducts([id])[0];
          if (!product) return null;
          const qty = quantities.get(product.id) ?? 0;
          return <div className={s.reelChip}>
            <button type="button" className={s.reelChipInfo} onClick={() => onOpenProduct(product)}>
              <span className={s.reelChipImage}>{product.imageUrls[0] ? <StoreImage src={product.imageUrls[0]} alt="" sizes="40px" /> : null}</span>
              <span className="min-w-0"><span className={s.reelChipName}>{product.name}</span><span className={s.reelChipPrice}>{formatStorePrice(product.price)}</span></span>
            </button>
            <button type="button" className={s.reelChipAdd} disabled={!product.inStock} aria-label={qty ? `${product.name}: ${qty} in cart, add one more` : `Add ${product.name} to cart`} onClick={() => onAdd(product)}>{qty ? qty : <Plus size={16} />}</button>
          </div>;
        }} />;
      case "bundles": {
        const title = (section as LayoutSection<"bundles">).settings.title;
        return store.bundles?.length ? <section className={s.section} aria-labelledby="bundle-head"><SectionHead id="bundle-head" title={title} aside="Save when you buy these as a set" /><Rail label="Bundle offers" wide>{store.bundles.map((bundle) => (
          <article key={bundle.id} className={s.bundle}>
            <div className={s.bundleImages}>{bundle.components.slice(0, 3).map((item, i) => <span key={item.product.id}>{i > 0 ? <Plus className={s.bundlePlus} size={12} aria-hidden /> : null}<span className={s.bundleImage}><StoreImage src={item.product.imageUrls[0]} alt={item.product.name} sizes="64px" /></span></span>)}</div>
            <h3>{bundle.name}</h3>
            <p className={s.bundleItems}>{bundle.components.map((c) => `${c.quantity} × ${c.product.name}`).join(", ")}</p>
            <div className={s.price}>{formatStorePrice(bundle.total)}<del>{formatStorePrice(bundle.subtotal)}</del></div>
            <p className={s.saving}>You save {formatStorePrice(bundle.savings)}</p>
            <button type="button" className={`${s.add} w-full`} disabled={bundle.components.some((c) => !c.product.inStock)} onClick={() => onBundle(bundle)}><Plus size={15} />Add set to cart</button>
          </article>
        ))}</Rail></section> : null;
      }
      case "upsell": {
        const title = (section as LayoutSection<"upsell">).settings.title;
        const shown = new Set([...featuredIds, ...best.map((p) => p.id)]);
        const related = (store.products.related ?? []).filter((p) => !shown.has(p.id)).slice(0, 10);
        return related.length ? <section className={s.section} aria-labelledby="upsell-head"><SectionHead id="upsell-head" title={title} /><Rail label={title || "You may also like"}>{related.map(card)}</Rail></section> : null;
      }
      case "best_sellers": {
        const title = (section as LayoutSection<"best_sellers">).settings.title;
        return best.length ? <section className={s.section} id="best-sellers" aria-labelledby="best-head"><SectionHead id="best-head" title={title} /><Rail label={title || "Best sellers"}>{best.map(card)}</Rail></section> : null;
      }
      case "testimonials":
        return <TestimonialsSection section={section as LayoutSection<"testimonials">} />;
      case "rich_text":
        return <RichTextSection section={section as LayoutSection<"rich_text">} />;
      case "countdown":
        return <CountdownSection section={section as LayoutSection<"countdown">} storeHref={linkFor} />;
      default:
        return null;
    }
  }

  const header = layout?.header;
  const menu = header?.menu ?? [];
  const menuHref = (link: (typeof menu)[number]) => {
    if (link.kind === "policy") return storeHref(`/store/${store.workspace}/${link.value}`);
    if (link.kind === "section") return `#section-${link.value}`;
    if (link.kind === "category") return `#all-products`;
    return linkFor(link.value);
  };
  const menuLinks = menu.map((link, index) => (
    <a key={`${link.kind}-${link.value}-${index}`} href={menuHref(link)} {...(link.kind === "url" && /^https?:\/\//i.test(link.value) ? { target: "_blank", rel: "noopener noreferrer" } : {})} onClick={(event) => {
      if (link.kind === "category") { event.preventDefault(); if (detail) onHome?.(); pickCategory(link.value); }
      else if (link.kind === "section" && detail) { onHome?.(); }
    }}>{link.label}</a>
  ));
  const goHome = () => { if (detail) onHome?.(); onFilters(EMPTY_FILTERS); onQueryChange(""); onCategoryChange("all"); window.scrollTo({ top: 0, behavior: "smooth" }); };
  return <>
    {header?.announcement.enabled ? <AnnouncementBar text={header.announcement.text} href={header.announcement.href} storeHref={linkFor} marquee={header.announcement.style === "marquee"} /> : null}
    <header className={s.header}><div className={`${s.inner} ${s.topbar}`}>
      <a className={s.brand} href={storeHref(`/store/${store.workspace}`)} onClick={(event) => { if (!detail) return; event.preventDefault(); onHome?.(); }}>
        <span className={s.logo}>{store.logoUrl ? <StoreImage src={store.logoUrl} alt="" sizes="36px" /> : <span className={s.monogram}>{store.storeName.trim().charAt(0).toUpperCase()}</span>}</span>
        <span>{store.storeName}</span>
      </a>
      {menu.length ? <nav className={s.inlineMenu} aria-label="Store menu">{menuLinks}</nav> : null}
      <div className={s.search} role="search">
        <Search aria-hidden />
        <input aria-label="Search products" type="search" value={query} onChange={(e) => onQueryChange(e.target.value)} placeholder={`Search ${store.storeName}`} enterKeyHint="search" />
        {query ? <button type="button" aria-label="Clear search" onClick={() => onQueryChange("")}><X size={16} /></button> : null}
      </div>
      <button type="button" className={s.icon} aria-label={`Open cart, ${cartCount} items`} onClick={onOpenCart}><ShoppingBag size={21} />{cartCount ? <span className={s.badge}>{cartCount}</span> : null}</button>
    </div>
    {menu.length ? <nav className={`${s.inner} ${s.menu}`} aria-label="Store menu">{menuLinks}</nav> : null}
    </header>
    <div className={s.inner}>
      {detail ?? <>
      {header?.showCategoryBar === false ? null : <nav className={s.categories} aria-label="Product categories">
        <button type="button" aria-pressed={categoryId === "all"} onClick={() => onCategoryChange("all")}><Grid2X2 size={16} />All products</button>
        {store.categories.map((c) => <button type="button" key={c.id} aria-pressed={categoryId === c.id} onClick={() => onCategoryChange(c.id)}>{c.imageUrl ? <span className={s.categoryImage}><StoreImage src={c.imageUrl} alt="" sizes="26px" /></span> : null}{c.name}</button>)}
      </nav>}
      {sections.map((section) => {
        if (!section.visible) return null;
        if (section.type === "catalog") return <Fragment key={section.id}>{catalogSection(section as LayoutSection<"catalog">)}</Fragment>;
        if (!home) return null;
        return <Fragment key={section.id}>{renderSection(section)}</Fragment>;
      })}
      </>}
    </div>
    <StorefrontFooter footer={store.footer} />
    {layout?.tokens.mobileNav ? <MobileTabBar cartCount={cartCount} onHome={goHome} onShop={() => { if (detail) onHome?.(); requestAnimationFrame(scrollToCatalog); }}
      onCategories={store.categories.length ? () => { if (detail) onHome?.(); requestAnimationFrame(() => (document.getElementById("shop-by-category") ?? document.getElementById("all-products"))?.scrollIntoView({ behavior: "smooth" })); } : undefined}
      onCart={onOpenCart} /> : null}
    {layout?.whatsappButton.enabled && store.whatsappPhone ? <WhatsAppFloat phone={store.whatsappPhone} message={layout.whatsappButton.message} position={layout.whatsappButton.position} storeName={store.storeName} /> : null}
    <Dialog open={filtersOpen} onOpenChange={setFiltersOpen}><DialogContent className="max-w-sm rounded-lg"><DialogTitle>Filter products</DialogTitle>{filterFields}<button type="button" className="h-11 rounded-md bg-zinc-900 text-sm font-semibold text-white" onClick={() => setFiltersOpen(false)}>Show {store.products.total} products</button></DialogContent></Dialog>
  </>;
}
