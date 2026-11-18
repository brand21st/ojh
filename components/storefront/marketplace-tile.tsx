"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Minus, Plus } from "lucide-react";
import { StoreImage } from "./store-image";
import type { StoreProduct } from "./store-types";
import { formatStorePrice } from "@/modules/storefront/pricing";
import s from "./marketplace.module.css";

export function savingsPercent(product: Pick<StoreProduct, "price" | "compareAtPrice" | "discountPercent">) {
  if (product.discountPercent) return product.discountPercent;
  if (!product.compareAtPrice || product.compareAtPrice <= product.price) return null;
  return Math.round(((product.compareAtPrice - product.price) / product.compareAtPrice) * 100) || null;
}

export function stockNote(product: StoreProduct) {
  if (!product.inStock) return "Out of stock";
  const threshold = product.lowStockThreshold ?? 5;
  if (product.onHand > 0 && product.onHand <= threshold) return `Only ${product.onHand} left`;
  return null;
}

export function ProductTile({
  product,
  quantity,
  onOpen,
  onAdd,
  onDecrease,
  href,
}: {
  product: StoreProduct;
  quantity: number;
  onOpen: () => void;
  onAdd: () => void;
  onDecrease: () => void;
  href?: string;
}) {
  const off = savingsPercent(product);
  const note = stockNote(product);
  const open = (event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button === 1) return;
    event.preventDefault();
    onOpen();
  };
  return (
    <article className={s.product} data-soldout={!product.inStock || undefined}>
      <a className={s.productImage} href={href ?? "#"} onClick={open} aria-label={`View ${product.name}`}>
        <StoreImage src={product.imageUrls[0]} alt={product.name} sizes="(max-width: 599px) 46vw, (max-width: 899px) 30vw, 240px" />
        {off ? <span className={s.offTag}>{off}% off</span> : null}
        {product.bestSeller ? <span className={s.label}>Best seller</span> : null}
      </a>
      <div className={s.productBody}>
        <a className={s.productName} href={href ?? "#"} onClick={open}>{product.name}</a>
        <div className={s.price}>
          {formatStorePrice(product.price)}
          {product.compareAtPrice && product.compareAtPrice > product.price ? <del>{formatStorePrice(product.compareAtPrice)}</del> : null}
        </div>
        <div className={s.saving} data-tone={!product.inStock ? "muted" : note ? "warn" : undefined}>{note ?? ""}</div>
        {quantity > 0 ? (
          <div className={s.stepper}>
            <button type="button" aria-label={`Decrease ${product.name}`} onClick={onDecrease}><Minus size={15} /></button>
            <span aria-live="polite">{quantity} in cart</span>
            <button type="button" disabled={quantity >= product.onHand} aria-label={`Increase ${product.name}`} onClick={onAdd}><Plus size={15} /></button>
          </div>
        ) : (
          <button type="button" className={s.add} disabled={!product.inStock} onClick={onAdd}>
            {product.inStock ? <><Plus size={15} />Add to cart</> : "Sold out"}
          </button>
        )}
      </div>
    </article>
  );
}

export function Rail({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 4, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 4 });
  }, []);
  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);
  const scroll = (direction: 1 | -1) => {
    const el = ref.current;
    if (el) el.scrollBy({ left: direction * el.clientWidth * 0.85, behavior: "smooth" });
  };
  return (
    <div className={s.railWrap}>
      <div ref={ref} className={s.rail} data-wide={wide || undefined} role="region" aria-label={label} tabIndex={0} onScroll={measure}>
        {children}
      </div>
      {edges.left ? <button type="button" className={s.railNav} data-side="left" aria-label={`Scroll ${label} left`} onClick={() => scroll(-1)}><ChevronLeft size={18} /></button> : null}
      {edges.right ? <button type="button" className={s.railNav} data-side="right" aria-label={`Scroll ${label} right`} onClick={() => scroll(1)}><ChevronRight size={18} /></button> : null}
    </div>
  );
}
