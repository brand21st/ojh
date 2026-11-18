"use client";

import { useEffect, useRef, useState } from "react";
import { Banknote, Check, ChevronLeft, ChevronRight, Minus, Plus, RotateCcw, Share2, Truck } from "lucide-react";
import { StoreImage } from "@/components/storefront/store-image";
import { StorePincodeLookup } from "@/components/storefront/store-pincode-lookup";
import type { StoreCategory, StoreProduct } from "@/components/storefront/store-types";
import { formatStorePrice } from "@/modules/storefront/pricing";
import { ProductTile, Rail, savingsPercent, stockNote } from "./marketplace-tile";
import s from "./marketplace.module.css";

type StoreRef = { workspace?: string; publicId?: string; token?: string };

function Gallery({ product }: { product: StoreProduct }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const images = product.imageUrls.length ? product.imageUrls : [null];
  const goTo = (next: number) => {
    const target = Math.max(0, Math.min(images.length - 1, next));
    setIndex(target);
    const el = scroller.current;
    el?.scrollTo({ left: target * el.clientWidth, behavior: "smooth" });
  };
  return (
    <div className={s.gallery}>
      <div className={s.galleryStage}>
        <div
          ref={scroller}
          className={s.galleryTrack}
          role="region"
          aria-roledescription="carousel"
          aria-label={`${product.name} photos`}
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === "ArrowLeft") goTo(index - 1); if (e.key === "ArrowRight") goTo(index + 1); }}
          onScroll={() => { const el = scroller.current; if (el?.clientWidth) setIndex(Math.round(el.scrollLeft / el.clientWidth)); }}
        >
          {images.map((url, i) => (
            <div key={url ?? i} className={s.gallerySlide} aria-roledescription="slide" aria-label={`${i + 1} of ${images.length}`}>
              <StoreImage src={url} alt={i === 0 ? product.name : `${product.name}, photo ${i + 1}`} sizes="(max-width: 899px) 100vw, 720px" preload={i === 0} />
            </div>
          ))}
        </div>
        {images.length > 1 ? (
          <>
            <button type="button" className={s.galleryNav} data-side="left" disabled={index === 0} aria-label="Previous photo" onClick={() => goTo(index - 1)}><ChevronLeft size={18} /></button>
            <button type="button" className={s.galleryNav} data-side="right" disabled={index === images.length - 1} aria-label="Next photo" onClick={() => goTo(index + 1)}><ChevronRight size={18} /></button>
            <span className={s.galleryCount} aria-hidden>{index + 1} / {images.length}</span>
          </>
        ) : null}
      </div>
      {images.length > 1 ? (
        <div className={s.thumbs}>
          {product.imageUrls.map((url, i) => (
            <button key={url} type="button" aria-label={`Show photo ${i + 1}`} aria-current={i === index} onClick={() => goTo(i)}>
              <StoreImage src={url} alt="" sizes="64px" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DeliveryCheck({ linkRef, preview }: { linkRef: StoreRef; preview?: boolean }) {
  const [pin, setPin] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [place, setPlace] = useState<string | null>(null);
  return (
    <div className={s.delivery}>
      <label htmlFor="delivery-pin"><Truck size={16} aria-hidden />Check delivery to your PIN code</label>
      <form className={s.pinRow} onSubmit={(e) => { e.preventDefault(); setPlace(null); setSubmitted(pin); }}>
        <input id="delivery-pin" inputMode="numeric" autoComplete="postal-code" maxLength={6} pattern="\d{6}" placeholder="6-digit PIN code" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))} />
        <button type="submit" disabled={pin.length !== 6}>Check</button>
      </form>
      {submitted && !preview ? (
        <div className={s.pinResult} aria-live="polite">
          <StorePincodeLookup linkRef={linkRef} pincode={submitted} onResolve={(city, state) => setPlace([city, state].filter(Boolean).join(", "))} />
          {place ? <p><Check size={14} aria-hidden />Ships by India Post to {place}.</p> : null}
        </div>
      ) : submitted ? <p className={s.pinResult}>Delivery lookup works on the live store.</p> : null}
    </div>
  );
}

function ShareButton({ name }: { name: string }) {
  const [copied, setCopied] = useState(false);
  async function share() {
    const url = window.location.href;
    try {
      if (navigator.share) { await navigator.share({ title: name, url }); return; }
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // The shopper dismissed the share sheet.
    }
  }
  return <button type="button" className={s.share} onClick={() => void share()}><Share2 size={15} aria-hidden />{copied ? "Link copied" : "Share"}</button>;
}

const LONG_DESCRIPTION = 420;

export function MarketplaceProduct({
  product,
  quantity,
  related,
  categories = [],
  workspace,
  linkRef = {},
  preview,
  onBack,
  onAdd,
  onDecrease,
  onOpenProduct,
  onBuyNow,
  cartQuantity,
}: {
  product: StoreProduct;
  quantity: number;
  related: StoreProduct[];
  categories?: StoreCategory[];
  workspace?: string;
  linkRef?: StoreRef;
  preview?: boolean;
  onBack: () => void;
  onAdd: (product: StoreProduct) => void;
  onDecrease: (productId: string) => void;
  onOpenProduct: (product: StoreProduct) => void;
  onBuyNow?: (product: StoreProduct) => void;
  cartQuantity?: (productId: string) => number;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState(false);
  // The parent keys this component by product id, so local state resets on navigation.
  useEffect(() => { window.scrollTo(0, 0); }, []);

  const off = savingsPercent(product);
  const note = stockNote(product);
  const category = categories.find((c) => product.categoryIds?.includes(c.id));
  const buyTogether = related.filter((item) => item.inStock && item.id !== product.id).slice(0, 3);
  const buyIds = new Set(buyTogether.map((item) => item.id));
  const recommendations = related.filter((item) => item.id !== product.id && !buyIds.has(item.id)).slice(0, 10);
  const chosen = buyTogether.filter((item) => selected.includes(item.id));
  const togetherTotal = product.price + chosen.reduce((sum, item) => sum + item.price, 0);
  const description = product.description?.trim() ?? "";
  const longDescription = description.length > LONG_DESCRIPTION;
  const payment = [
    product.prepaidEnabled ? "Prepaid" : null,
    product.codEnabled ? (product.codAdvancePercent ? `Cash on delivery (${product.codAdvancePercent}% advance)` : "Cash on delivery") : null,
  ].filter(Boolean).join(" or ");
  const hrefFor = (item: StoreProduct) => (workspace && item.slug ? `/store/${workspace}/products/${item.slug}` : undefined);

  function addSelected() {
    if (product.inStock && quantity === 0) onAdd(product);
    for (const item of chosen) onAdd(item);
    setSelected([]);
  }

  const purchase = (
    <div className={s.purchase}>
      {quantity > 0 ? (
        <div className={s.stepper} data-size="lg">
          <button type="button" aria-label={`Decrease ${product.name}`} onClick={() => onDecrease(product.id)}><Minus size={16} /></button>
          <span aria-live="polite">{quantity} in cart</span>
          <button type="button" aria-label={`Increase ${product.name}`} disabled={quantity >= product.onHand} onClick={() => onAdd(product)}><Plus size={16} /></button>
        </div>
      ) : (
        <button type="button" className={s.secondaryAction} disabled={!product.inStock} onClick={() => onAdd(product)}>{product.inStock ? "Add to cart" : "Sold out"}</button>
      )}
      {product.inStock && onBuyNow ? <button type="button" className={s.add} data-size="lg" onClick={() => onBuyNow(product)}>Buy now</button> : null}
    </div>
  );

  return (
    <>
      <nav className={s.crumbs} aria-label="Breadcrumb">
        <ol>
          <li><a href={workspace ? `/store/${workspace}` : "#"} onClick={(e) => { e.preventDefault(); onBack(); }}>Shop</a></li>
          {category ? <li>{workspace ? <a href={`/store/${workspace}/category/${category.slug}`}>{category.name}</a> : category.name}</li> : null}
          <li aria-current="page">{product.name}</li>
        </ol>
      </nav>
      <article className={s.detail}>
        <Gallery product={product} />
        <div className={s.detailCopy}>
          <h1>{product.name}</h1>
          <div className={s.detailPrice}>
            <span>{formatStorePrice(product.price)}</span>
            {product.compareAtPrice && product.compareAtPrice > product.price ? <>
              <del aria-label={`Was ${formatStorePrice(product.compareAtPrice)}`}>{formatStorePrice(product.compareAtPrice)}</del>
              {off ? <span className={s.offPill}>{off}% off</span> : null}
            </> : null}
          </div>
          {product.compareAtPrice && product.compareAtPrice > product.price ? <p className={s.saveLine}>You save {formatStorePrice(product.compareAtPrice - product.price)}</p> : null}
          <p className={s.stock} data-tone={!product.inStock ? "muted" : note ? "warn" : "ok"}>{!product.inStock ? "Out of stock right now" : note ?? "In stock, ready to ship"}</p>
          <div className={s.purchaseDesktop}>{purchase}</div>
          <ul className={s.facts}>
            <li><Truck size={17} aria-hidden /><span><strong>Delivery</strong>Shipped by India Post with a tracking number.</span></li>
            {payment ? <li><Banknote size={17} aria-hidden /><span><strong>Payment</strong>{payment}.</span></li> : null}
            <li><RotateCcw size={17} aria-hidden /><span><strong>Returns</strong>{product.returnAvailable === false ? "This item can't be returned." : "This item can be returned. See the store's return policy."}</span></li>
          </ul>
          <DeliveryCheck linkRef={linkRef} preview={preview} />
          {description ? (
            <section className={s.description} aria-labelledby="about-head">
              <h2 id="about-head">About this product</h2>
              <p data-clamped={longDescription && !expanded ? true : undefined}>{description}</p>
              {longDescription ? <button type="button" className={s.textButton} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Read more"}</button> : null}
            </section>
          ) : null}
          <div className={s.detailFoot}>
            {product.sku ? <span>SKU {product.sku}</span> : <span />}
            <ShareButton name={product.name} />
          </div>
          {buyTogether.length ? (
            <section className={s.buy} aria-labelledby="together-head">
              <h2 id="together-head">Frequently bought together</h2>
              {buyTogether.map((item) => (
                <label key={item.id} className={s.buyRow}>
                  <input type="checkbox" checked={selected.includes(item.id)} onChange={(event) => setSelected(event.target.checked ? [...selected, item.id] : selected.filter((id) => id !== item.id))} />
                  <span className={s.buyThumb}><StoreImage src={item.imageUrls[0]} alt="" sizes="44px" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{item.name}</span>
                    <span className="text-xs text-zinc-600">{formatStorePrice(item.price)}{(cartQuantity?.(item.id) ?? 0) > 0 ? " · in your cart" : ""}</span>
                  </span>
                  <button type="button" className={s.textButton} onClick={(e) => { e.preventDefault(); onOpenProduct(item); }}>View</button>
                </label>
              ))}
              {chosen.length ? <button type="button" className={s.ghost} onClick={addSelected}>Add {chosen.length + (quantity === 0 && product.inStock ? 1 : 0)} items · {formatStorePrice(quantity === 0 && product.inStock ? togetherTotal : togetherTotal - product.price)}</button> : null}
            </section>
          ) : null}
        </div>
      </article>
      <div className={s.purchaseMobile}>
        <div className={s.purchaseMobilePrice}><strong>{formatStorePrice(product.price)}</strong>{off ? <span>{off}% off</span> : null}</div>
        {purchase}
      </div>
      {recommendations.length ? (
        <section className={s.section} aria-labelledby="also-head">
          <div className={s.sectionHead}><h2 id="also-head">You may also like</h2></div>
          <Rail label="You may also like">
            {recommendations.map((item) => (
              <ProductTile key={item.id} product={item} href={hrefFor(item)} quantity={cartQuantity?.(item.id) ?? 0} onOpen={() => onOpenProduct(item)} onAdd={() => onAdd(item)} onDecrease={() => onDecrease(item.id)} />
            ))}
          </Rail>
        </section>
      ) : null}
    </>
  );
}
