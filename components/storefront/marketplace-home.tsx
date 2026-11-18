"use client";

import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Banknote, Grid2X2, Plus, RotateCcw, Search, ShoppingBag, SlidersHorizontal, Truck, Wallet, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { CoverHero } from "./cover-hero";
import { ProductTile, Rail } from "./marketplace-tile";
import { StoreImage } from "./store-image";
import { StorefrontFooter } from "./storefront-footer";
import type { CartLine, StorePayload, StoreProduct, StoreBundle } from "./store-types";
import { formatStorePrice } from "@/modules/storefront/pricing";
import s from "./marketplace.module.css";

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

function StoreIntro({ store, showcase, onBrowseCategories }: { store: StorePayload; showcase: StoreProduct[]; onBrowseCategories?: () => void }) {
  const tagline = store.seoDescription || store.footer?.brand?.tagline || `Order directly from ${store.storeName} and get it delivered to your door.`;
  const pictures = showcase.filter((p) => p.imageUrls[0]).slice(0, 3);
  return (
    <section className={s.intro} aria-labelledby="store-title">
      <div className={s.introCopy}>
        {store.logoUrl ? <span className={s.introLogo}><StoreImage src={store.logoUrl} alt="" sizes="64px" preload /></span> : null}
        <h1 id="store-title">{store.storeName}</h1>
        <p>{tagline}</p>
        <div className={s.introActions}>
          <button type="button" className={s.primary} onClick={scrollToCatalog}>Shop all products</button>
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
  const productHref = (product: StoreProduct) => (product.slug ? `/store/${store.workspace}/products/${product.slug}` : undefined);
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

  return <>
    <header className={s.header}><div className={`${s.inner} ${s.topbar}`}>
      <a className={s.brand} href={`/store/${store.workspace}`} onClick={(event) => { if (!detail) return; event.preventDefault(); onHome?.(); }}>
        <span className={s.logo}>{store.logoUrl ? <StoreImage src={store.logoUrl} alt="" sizes="36px" /> : <span className={s.monogram}>{store.storeName.trim().charAt(0).toUpperCase()}</span>}</span>
        <span>{store.storeName}</span>
      </a>
      <div className={s.search} role="search">
        <Search aria-hidden />
        <input aria-label="Search products" type="search" value={query} onChange={(e) => onQueryChange(e.target.value)} placeholder={`Search ${store.storeName}`} enterKeyHint="search" />
        {query ? <button type="button" aria-label="Clear search" onClick={() => onQueryChange("")}><X size={16} /></button> : null}
      </div>
      <button type="button" className={s.icon} aria-label={`Open cart, ${cartCount} items`} onClick={onOpenCart}><ShoppingBag size={21} />{cartCount ? <span className={s.badge}>{cartCount}</span> : null}</button>
    </div></header>
    <div className={s.inner}>
      {detail ?? <>
      <nav className={s.categories} aria-label="Product categories">
        <button type="button" aria-pressed={categoryId === "all"} onClick={() => onCategoryChange("all")}><Grid2X2 size={16} />All products</button>
        {store.categories.map((c) => <button type="button" key={c.id} aria-pressed={categoryId === c.id} onClick={() => onCategoryChange(c.id)}>{c.imageUrl ? <span className={s.categoryImage}><StoreImage src={c.imageUrl} alt="" sizes="26px" /></span> : null}{c.name}</button>)}
      </nav>
      {home ? (banner?.imageUrl ? <>
        <h1 className="sr-only">{store.storeName}</h1>
        <section className={s.banner} aria-label="Store offer"><CoverHero slide={banner} preload onVisible={() => onCoverEvent?.("COVER_IMPRESSION", banner.id)} onCtaClick={() => onCoverEvent?.("COVER_CLICK", banner.id)} /></section>
      </> : <StoreIntro store={store} showcase={[...featured, ...best, ...store.products.items]} onBrowseCategories={categoryTiles ? () => document.getElementById("shop-by-category")?.scrollIntoView({ behavior: "smooth" }) : undefined} />) : null}
      {home ? <ul className={s.promises} aria-label="Why shop here" style={{ "--promise-cols": promises.length } as CSSProperties}>{promises.map((p) => <li key={p.title}><span className={s.promiseIcon}>{p.icon}</span><span><strong>{p.title}</strong><span>{p.body}</span></span></li>)}</ul> : null}
      {home && categoryTiles ? <section className={s.section} id="shop-by-category" aria-labelledby="cat-head">
        <div className={s.sectionHead}><h2 id="cat-head">Shop by category</h2></div>
        <div className={s.categoryGrid}>{store.categories.slice(0, 12).map((c) => (
          <button type="button" key={c.id} className={s.categoryTile} onClick={() => pickCategory(c.id)}>
            <span className={s.categoryArt}>{c.imageUrl ? <StoreImage src={c.imageUrl} alt="" sizes="(max-width: 599px) 30vw, 160px" /> : <span aria-hidden>{c.name.trim().charAt(0).toUpperCase()}</span>}</span>
            <span className={s.categoryName}>{c.name}</span>
          </button>
        ))}</div>
      </section> : null}
      {home && featured.length ? <section className={s.section} aria-labelledby="featured-head"><div className={s.sectionHead}><h2 id="featured-head">Featured picks</h2></div><Rail label="Featured picks">{featured.map(card)}</Rail></section> : null}
      {home && store.bundles?.length ? <section className={s.section} aria-labelledby="bundle-head"><div className={s.sectionHead}><h2 id="bundle-head">Better together</h2><span>Save when you buy these as a set</span></div><Rail label="Bundle offers" wide>{store.bundles.map((bundle) => (
        <article key={bundle.id} className={s.bundle}>
          <div className={s.bundleImages}>{bundle.components.slice(0, 3).map((item, i) => <span key={item.product.id}>{i > 0 ? <Plus className={s.bundlePlus} size={12} aria-hidden /> : null}<span className={s.bundleImage}><StoreImage src={item.product.imageUrls[0]} alt={item.product.name} sizes="64px" /></span></span>)}</div>
          <h3>{bundle.name}</h3>
          <p className={s.bundleItems}>{bundle.components.map((c) => `${c.quantity} × ${c.product.name}`).join(", ")}</p>
          <div className={s.price}>{formatStorePrice(bundle.total)}<del>{formatStorePrice(bundle.subtotal)}</del></div>
          <p className={s.saving}>You save {formatStorePrice(bundle.savings)}</p>
          <button type="button" className={`${s.add} w-full`} disabled={bundle.components.some((c) => !c.product.inStock)} onClick={() => onBundle(bundle)}><Plus size={15} />Add set to cart</button>
        </article>
      ))}</Rail></section> : null}
      {home && best.length ? <section className={s.section} aria-labelledby="best-head"><div className={s.sectionHead}><h2 id="best-head">Best sellers</h2></div><Rail label="Best sellers">{best.map(card)}</Rail></section> : null}
      <section className={`${s.section} ${s.catalogSection}`} id="all-products" aria-labelledby="catalog-head">
        <div className={s.sectionHead}>
          <h2 id="catalog-head">{query ? `Results for “${query}”` : activeCategory?.name ?? "All products"}</h2>
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
      </>}
    </div>
    <StorefrontFooter footer={store.footer} />
    <Dialog open={filtersOpen} onOpenChange={setFiltersOpen}><DialogContent className="max-w-sm rounded-lg"><DialogTitle>Filter products</DialogTitle>{filterFields}<button type="button" className="h-11 rounded-md bg-zinc-900 text-sm font-semibold text-white" onClick={() => setFiltersOpen(false)}>Show {store.products.total} products</button></DialogContent></Dialog>
  </>;
}
