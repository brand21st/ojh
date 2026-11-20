"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import dynamic from "next/dynamic";
import { MarketplaceHome, EMPTY_FILTERS, type CatalogFilters } from "./marketplace-home";
import { MarketplaceProduct } from "./marketplace-product";
import marketStyles from "./marketplace.module.css";
import { contrastText, onAccent } from "@/modules/storefront/config";
import { bundleCartLine, cartRequest, ungroupBundle } from "@/modules/storefront/cart";
import { commerceEvent, emitStoreEvent } from "@/modules/storefront/tracking-events";
import { StoreTracking } from "./store-tracking";
import { CouponBanner } from "./coupon-field";
import { StoreBaseProvider, useStoreHref } from "./store-base";
import { useStoreCoupon } from "./coupon-storage";
import { rememberBuyerPhone } from "./fast-checkout";
import { CheckoutForm } from "./checkout-form";
import { ShoppingBag } from "lucide-react";
import { StoreOrderSuccess, type StoreOrderReceipt } from "@/components/storefront/order-success";
import type { OnlinePaymentHandle } from "@/components/storefront/online-payment";
import { StoreHome } from "@/components/storefront/store-home";
import { StoreSkeleton } from "@/components/storefront/store-skeleton";
import type { CartLine, StorePayload, StoreProduct, StoreBundle } from "@/components/storefront/store-types";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/hooks/use-api";
import { extractIndiaMobileDigits } from "@/lib/phone/india-whatsapp";
import { publicOrderLinkApiPath } from "@/modules/customer-order-links/schema";
import { formatStorePrice } from "@/modules/storefront/pricing";
import { summarizeReturnPolicy } from "@/modules/products/return-policy";
import { pickStoreRecommendations } from "@/modules/storefront/recommendations";
import { trendingProducts } from "@/modules/storefront/trending";

type StoreRef = { workspace?: string; publicId?: string; token?: string };
const CartSheet = dynamic(() => import("./cart-sheet").then((m) => m.CartSheet));
const ProductDetailSheet = dynamic(() => import("./product-detail-sheet").then((m) => m.ProductDetailSheet));

function cartKey(workspace: string) {
  return `postbus-store-cart:${workspace}`;
}

function catalogParams(ref: StoreRef, page: number, pageSize: number, query: string, categoryId: string, filters: CatalogFilters = EMPTY_FILTERS) {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (ref.workspace) params.set("workspace", ref.workspace);
  if (ref.publicId) params.set("code", ref.publicId);
  if (ref.token) params.set("token", ref.token);
  if (query.trim()) params.set("q", query.trim());
  if (categoryId !== "all") params.set("categoryId", categoryId);
  params.set("sort", filters.sort);
  if (filters.priceMin !== "") params.set("priceMin", filters.priceMin);
  if (filters.priceMax !== "") params.set("priceMax", filters.priceMax);
  if (filters.inStock) params.set("inStock", "true");
  return params;
}

type StoreAppProps = StoreRef & {
  initialStore?: StorePayload | null;
  initialProduct?: StoreProduct | null;
  initialCategoryId?: string;
  preview?: StorePayload | null;
  /** `""` on the merchant's own subdomain, `/store/{slug}` on the PostBus host. Unset in previews. */
  basePath?: string;
};

export function StoreApp({ basePath, ...props }: StoreAppProps) {
  return (
    <StoreBaseProvider workspace={props.workspace ?? ""} basePath={props.preview ? undefined : basePath}>
      <StoreAppInner {...props} />
    </StoreBaseProvider>
  );
}

function StoreAppInner({
  workspace,
  publicId,
  token,
  initialStore,
  initialProduct,
  initialCategoryId = "all",
  preview,
}: Omit<StoreAppProps, "basePath">) {
  const storeHref = useStoreHref();
  const isPreview = Boolean(preview);
  const [loadedStore, setLoadedStore] = useState<StorePayload | null>(initialStore ?? null);
  const [loadError, setLoadError] = useState(false);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<CatalogFilters>(EMPTY_FILTERS);
  const [urlReady, setUrlReady] = useState(false);
  const browseUrl = useRef<string | null>(null);
  const browseScroll = useRef(0);
  const browseTitle = useRef<string | null>(null);
  const pushedProduct = useRef(false);
  const onProductPath = useRef(false);
  const [categoryId, setCategoryId] = useState<string | "all">(initialCategoryId);
  const [searching, setSearching] = useState(false);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartReady, setCartReady] = useState(isPreview);
  const [sheet, setSheet] = useState<"cart" | "checkout" | null>(null);
  const [checkoutStep, setCheckoutStep] = useState<"details" | "summary">("details");
  const [product, setProduct] = useState<StoreProduct | null>(initialProduct ?? null);
  const [orderReceipt, setOrderReceipt] = useState<StoreOrderReceipt | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const submissionIdRef = useRef<string | null>(null);
  const apiRef = useMemo(() => ({ workspace, publicId, token }), [workspace, publicId, token]);
  const workspaceKey = workspace || initialStore?.workspace || preview?.workspace || "preview";
  // A receipt with an online payment survives a redirect-style gateway checkout (in-app browsers)
  // in this tab only. The gateway session is never stored; the panel re-checks status on return.
  const receiptKey = `postbus-store-receipt:${workspaceKey}`;
  const dismissReceipt = useCallback(() => {
    setOrderReceipt(null);
    try {
      sessionStorage.removeItem(receiptKey);
    } catch {
      // storage unavailable
    }
  }, [receiptKey]);
  useEffect(() => {
    if (isPreview) return;
    const task = window.setTimeout(() => {
      try {
        const saved = sessionStorage.getItem(receiptKey);
        const parsed = saved ? (JSON.parse(saved) as StoreOrderReceipt) : null;
        if (parsed?.onlinePayment?.orderId && parsed.onlinePayment.token) setOrderReceipt(parsed);
      } catch {
        sessionStorage.removeItem(receiptKey);
      }
    }, 0);
    return () => window.clearTimeout(task);
  }, [isPreview, receiptKey]);
  // Coupon chosen by the shopper (typed or from a ?discount= magic link), remembered per store.
  const storeCoupon = useStoreCoupon(workspaceKey);
  const [promoDismissed, setPromoDismissed] = useState(false);
  useEffect(() => {
    if (isPreview) return;
    const read = () => {
      const params = new URLSearchParams(window.location.search);
      const nextOnProduct = window.location.pathname.includes("/products/");
      setQuery(params.get("q") ?? "");
      setCategoryId(params.get("category") ?? initialCategoryId);
      const nextFilters = { sort: params.get("sort") ?? "newest", priceMin: params.get("priceMin") ?? "", priceMax: params.get("priceMax") ?? "", inStock: params.get("inStock") === "true" };
      // Keep the same object when nothing changed so closing a product doesn't refetch the catalog.
      setFilters((current) => (JSON.stringify(current) === JSON.stringify(nextFilters) ? current : nextFilters));
      if (onProductPath.current && !nextOnProduct) {
        pushedProduct.current = false;
        setProduct(null);
        if (browseTitle.current) document.title = browseTitle.current;
        const y = browseScroll.current;
        requestAnimationFrame(() => window.scrollTo(0, y));
      }
      onProductPath.current = nextOnProduct;
      setUrlReady(true);
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, [initialCategoryId, isPreview]);
  useEffect(() => {
    if (!urlReady || isPreview || product) return;
    const url = new URL(window.location.href);
    for (const [key, value] of Object.entries({ q: query, category: categoryId === "all" ? "" : categoryId, sort: filters.sort === "newest" ? "" : filters.sort, priceMin: filters.priceMin, priceMax: filters.priceMax, inStock: filters.inStock ? "true" : "" })) {
      if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
    }
    window.history.replaceState(window.history.state, "", url);
  }, [categoryId, filters, isPreview, product, query, urlReady]);

  const loadStore = useCallback(async () => {
    if (isPreview) return;
    setLoadError(false);
    const params = new URLSearchParams();
    if (workspace) params.set("workspace", workspace);
    if (publicId) params.set("code", publicId);
    if (token) params.set("token", token);
    try {
      setLoadedStore(await api<StorePayload>(`/api/v1/public/store?${params}`));
    } catch {
      setLoadError(true);
    }
  }, [isPreview, publicId, token, workspace]);

  useEffect(() => {
    if (preview || initialStore) return;
    const task = window.setTimeout(() => void loadStore(), 0);
    return () => window.clearTimeout(task);
  }, [initialStore, loadStore, preview]);

  useEffect(() => {
    if (isPreview) return;
    const task = window.setTimeout(() => {
      try {
        const saved = sessionStorage.getItem(cartKey(workspaceKey));
        if (saved) {
          const parsed = JSON.parse(saved) as CartLine[];
          if (Array.isArray(parsed)) setCart(parsed.filter((line) => line?.product?.id && line.quantity > 0));
        }
      } catch {
        sessionStorage.removeItem(cartKey(workspaceKey));
      } finally {
        setCartReady(true);
      }
    }, 0);
    return () => window.clearTimeout(task);
  }, [isPreview, workspaceKey]);

  useEffect(() => {
    if (!cartReady || isPreview) return;
    sessionStorage.setItem(cartKey(workspaceKey), JSON.stringify(cart));
  }, [cart, cartReady, isPreview, workspaceKey]);

  useEffect(() => {
    const modalOpen = Boolean(sheet || product);
    if (!modalOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [product, sheet]);

  const store = useMemo(() => {
    const current = preview ?? loadedStore;
    if (!current || !preview) return current;
    const needle = query.trim().toLowerCase();
    const matchingCategoryIds = new Set(
      preview.categories
        .filter((category) => category.name.toLowerCase().includes(needle))
        .map((category) => category.id)
    );
    const items = preview.products.items.filter(
      (item) =>
        (categoryId === "all" || item.categoryIds?.includes(categoryId)) &&
        (!needle ||
          item.name.toLowerCase().includes(needle) ||
          item.sku.toLowerCase().includes(needle) ||
          item.categoryIds?.some((id) => matchingCategoryIds.has(id)))
    ).filter((item) => (!filters.inStock || item.inStock) && (filters.priceMin === "" || item.price >= Number(filters.priceMin)) && (filters.priceMax === "" || item.price <= Number(filters.priceMax)))
      .sort((a, b) => filters.sort === "priceAsc" ? a.price - b.price : filters.sort === "priceDesc" ? b.price - a.price : filters.sort === "name" ? a.name.localeCompare(b.name) : 0);
    return { ...current, products: { ...current.products, items, total: items.length, page: 1 } };
  }, [categoryId, filters, loadedStore, preview, query]);

  const catalogPool = useMemo(() => {
    const items = [...(store?.products.items ?? []), ...(store?.products.related ?? [])];
    const map = new Map<string, StoreProduct>();
    for (const item of items) map.set(item.id, item);
    return [...map.values()];
  }, [store]);

  useEffect(() => {
    if (isPreview || !urlReady) return;
    if (requestSequence.current === 0 && !query.trim() && categoryId === "all" && JSON.stringify(filters) === JSON.stringify(EMPTY_FILTERS)) {
      requestSequence.current = 1;
      return;
    }
    const sequence = ++requestSequence.current;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const products = await api<StorePayload["products"]>(
          `/api/v1/public/store/products?${catalogParams(apiRef, 1, 24, query, categoryId, filters)}`, { signal: controller.signal }
        );
        if (sequence === requestSequence.current) {
          setLoadedStore((current) => (current ? { ...current, products } : current));
        }
      } catch {
        // Preserve the last usable catalog during transient network failures.
      } finally {
        if (sequence === requestSequence.current) setSearching(false);
      }
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [apiRef, categoryId, filters, isPreview, query, urlReady]);

  const seenCovers = useRef(new Set<string>());

  function trackEvent(
    eventType: "PRODUCT_VIEW" | "PRODUCT_CLICK" | "ADD_TO_CART" | "CART_OPENED" | "CHECKOUT_STARTED" | "PURCHASE" | "COVER_IMPRESSION" | "COVER_CLICK",
    details?: { productId?: string; quantity?: number; value?: number; slideId?: string }
  ) {
    const names = { PRODUCT_VIEW: "view_item", PRODUCT_CLICK: "select_item", ADD_TO_CART: "add_to_cart", CART_OPENED: "view_cart", CHECKOUT_STARTED: "begin_checkout", PURCHASE: "purchase" } as const;
    const item = catalogPool.find((candidate) => candidate.id === details?.productId);
    if (eventType !== "PURCHASE" && eventType !== "COVER_IMPRESSION" && eventType !== "COVER_CLICK") {
      emitStoreEvent(workspaceKey, commerceEvent(names[eventType], { value: details?.value, items: item ? [{ item_id: item.id, item_name: item.name, price: item.price, quantity: details?.quantity ?? 1 }] : cart.map((line) => ({ item_id: line.product.id, item_name: line.product.name, price: line.product.price, quantity: line.quantity })) }));
    }
    if (isPreview) return;
    const sessionKey = `postbus-store-session:${workspaceKey}`;
    const sessionId = sessionStorage.getItem(sessionKey) || crypto.randomUUID();
    sessionStorage.setItem(sessionKey, sessionId);
    void fetch("/api/v1/public/store/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        workspace: apiRef.workspace,
        code: apiRef.publicId,
        token: apiRef.token,
        sessionId,
        eventType,
        device: window.matchMedia("(max-width: 767px)").matches ? "mobile" : "desktop",
        ...details,
      }),
    }).catch(() => undefined);
  }

  function closeProduct() {
    setProduct(null);
    if (isPreview) return;
    if (store) document.title = browseTitle.current ?? `${store.seoTitle || `${store.storeName} · Shop`} · PostBus`;
    const y = browseScroll.current;
    if (pushedProduct.current) {
      pushedProduct.current = false;
      onProductPath.current = false;
      window.history.back();
    } else if (window.location.pathname.includes("/products/")) {
      onProductPath.current = false;
      window.history.replaceState(window.history.state, "", browseUrl.current ?? storeHref(`/store/${workspaceKey}`));
    }
    requestAnimationFrame(() => window.scrollTo(0, y));
  }

  function openProduct(next: StoreProduct) {
    if (!isPreview && !product) {
      browseUrl.current = window.location.href;
      browseScroll.current = window.scrollY;
      if (!window.location.pathname.includes("/products/")) browseTitle.current = document.title;
    }
    if (!isPreview && store) document.title = `${next.name} · ${store.storeName} · PostBus`;
    if (!isPreview && next.slug && !window.location.pathname.endsWith(`/products/${next.slug}`)) {
      const url = storeHref(`/store/${workspaceKey}/products/${next.slug}`);
      if (product || window.location.pathname.includes("/products/")) window.history.replaceState({ storefrontProduct: next.slug }, "", url);
      else {
        window.history.pushState({ storefrontProduct: next.slug }, "", url);
        pushedProduct.current = true;
      }
      onProductPath.current = true;
    }
    setProduct(next);
    trackEvent("PRODUCT_CLICK", { productId: next.id });
    trackEvent("PRODUCT_VIEW", { productId: next.id });
  }

  function openCart() {
    setSheet("cart");
    trackEvent("CART_OPENED", { value: cart.reduce((sum, line) => sum + line.product.price * line.quantity, 0) });
    if (!isPreview && cart.length) {
      void Promise.all(
        cart.map(async (line) => {
          if (line.bundle) return line;
          try {
            const params = catalogParams(apiRef, 1, 1, "", "all");
            params.set("id", line.product.id);
            const current = await api<StoreProduct>(`/api/v1/public/store/product?${params}`);
            return { product: current, quantity: Math.min(line.quantity, current.onHand) };
          } catch {
            return line;
          }
        })
      ).then((lines) => setCart(lines.filter((line) => line.quantity > 0)));
    }
  }

  function addToCart(next: StoreProduct) {
    if (!next.inStock) return;
    trackEvent("ADD_TO_CART", { productId: next.id, quantity: 1, value: next.price });
    setCart((current) => {
      const existing = current.find((line) => line.product.id === next.id);
      if (!existing) return [...current, { product: next, quantity: 1 }];
      const quantity = Math.min(next.onHand, existing.quantity + 1);
      return current.map((line) => (line.product.id === next.id ? { ...line, product: next, quantity } : line));
    });
  }

  function buyNow(next: StoreProduct) {
    if (!next.inStock) return;
    const inCart = cart.some((line) => line.product.id === next.id);
    if (!inCart) addToCart(next);
    // Skip openCart's stock refresh: it reads the cart before this add lands and would drop the item.
    setSheet("cart");
    trackEvent("CART_OPENED", { value: cart.reduce((sum, line) => sum + line.product.price * line.quantity, 0) + (inCart ? 0 : next.price) });
  }

  function addBundle(bundle: StoreBundle) {
    emitStoreEvent(workspaceKey, commerceEvent("add_bundle", { value: bundle.total, items: bundle.components.map((item) => ({ item_id: item.product.id, item_name: item.product.name, price: item.product.price, quantity: item.quantity })) }));
    const next = bundleCartLine(bundle);
    setCart((current) => {
      const existing = current.find((line) => line.product.id === next.product.id);
      if (existing) return current.map((line) => line === existing ? { ...next, quantity: Math.min(next.product.onHand, line.quantity + 1) } : line);
      return [...current, next];
    });
  }

  function submissionId() {
    if (submissionIdRef.current) return submissionIdRef.current;
    const key = `postbus-store-submit:${workspaceKey}`;
    const saved = sessionStorage.getItem(key);
    const next = saved || crypto.randomUUID();
    sessionStorage.setItem(key, next);
    submissionIdRef.current = next;
    return next;
  }

  function decrease(productId: string) {
    const item = cart.find((line) => line.product.id === productId);
    if (item) emitStoreEvent(workspaceKey, commerceEvent("remove_from_cart", { value: item.product.price, items: [{ item_id: productId, item_name: item.product.name, price: item.product.price, quantity: 1 }] }));
    setCart((current) =>
      current
        .map((line) => (line.product.id === productId ? { ...line, quantity: line.quantity - 1 } : line))
        .filter((line) => line.quantity > 0)
    );
  }

  async function loadMore() {
    if (!store || isPreview || searching) return;
    const sequence = requestSequence.current;
    setSearching(true);
    try {
      const products = await api<StorePayload["products"]>(
        `/api/v1/public/store/products?${catalogParams(
          apiRef,
          store.products.page + 1,
          store.products.pageSize,
          query,
          categoryId,
          filters
        )}`
      );
      if (sequence !== requestSequence.current) return;
      setLoadedStore((current) =>
        current
          ? { ...current, products: { ...products, items: [...current.products.items, ...products.items] } }
          : current
      );
    } catch {
      setSubmitError("Could not load more products. Please try again.");
    } finally {
      setSearching(false);
    }
  }

  if (loadError) {
    return (
      <div className="flex min-h-[70dvh] items-center justify-center px-6 text-center">
        <div>
          <p className="text-xl font-bold">Something went wrong</p>
          <p className="mt-2 text-sm text-zinc-500">The store could not be loaded. Please try again.</p>
          <Button type="button" className="mt-5" onClick={() => void loadStore()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!store) return <StoreSkeleton />;

  if (!store.published && !isPreview) {
    return (
      <div className="flex min-h-[70dvh] items-center justify-center px-6 text-center">
        <div>
          <p className="text-xl font-bold">{store.storeName}</p>
          <p className="mt-2 text-sm text-zinc-500">Store temporarily unavailable.</p>
        </div>
      </div>
    );
  }

  if (orderReceipt) {
    return <><StoreOrderSuccess receipt={orderReceipt} onContinue={dismissReceipt} payment={{ apiRef, storeName: store.storeName, accent: store.accentColor }} />{store.marketplace ? <StoreTracking workspace={workspaceKey} config={store.tracking} preview={isPreview} /> : null}</>;
  }

  const count = cart.reduce((sum, line) => sum + line.quantity, 0);
  const total = cart.reduce((sum, line) => sum + line.product.price * line.quantity, 0);
  const recommendations = pickStoreRecommendations(
    catalogPool,
    cart,
    cart.flatMap((line) => line.product.crossSellIds ?? []),
    { limit: 3 }
  );
  const related = pickStoreRecommendations(
    catalogPool,
    cart,
    product?.upsellIds ?? [],
    { categoryIds: product?.categoryIds, excludeId: product?.id, limit: 8 }
  );

  const bannerCoupon = storeCoupon.coupon?.label
    ? { code: storeCoupon.coupon.code, label: storeCoupon.coupon.label, description: null }
    : store.promo && !storeCoupon.skipAuto
      ? { code: store.promo.code, label: store.promo.label, description: store.promo.description }
      : null;

  return (
    <div className={store.marketplace ? marketStyles.store : undefined} data-font={store.theme?.font ?? "geist"} style={store.marketplace ? { "--accent": store.accentColor, "--accent-text": contrastText(store.accentColor), "--secondary": store.theme?.secondaryColor, paddingBottom: product ? 0 : count ? 80 : 0 } as CSSProperties : undefined}>
      {storeCoupon.notice?.tone === "error" ? (
        <div role="alert" className="flex items-center justify-center gap-2 bg-zinc-900 px-4 py-2 text-center text-xs text-white sm:text-sm">
          <span>{storeCoupon.notice.text}</span>
          <button type="button" className="underline underline-offset-2" onClick={storeCoupon.dismissNotice}>Dismiss</button>
        </div>
      ) : bannerCoupon && !promoDismissed && !product ? (
        <CouponBanner {...bannerCoupon} accentColor={store.accentColor} onDismiss={() => setPromoDismissed(true)} />
      ) : null}
      {store.marketplace ? <MarketplaceHome store={store} cart={cart} query={query} categoryId={categoryId} searching={searching} filters={filters} onFilters={setFilters} onQueryChange={(value) => { setQuery(value); if (product) { pushedProduct.current = false; onProductPath.current = false; setProduct(null); } }} onCategoryChange={setCategoryId} onOpenCart={openCart} onOpenProduct={openProduct} onAdd={addToCart} onDecrease={decrease} onLoadMore={() => void loadMore()} onBundle={addBundle} onHome={closeProduct} onCoverEvent={(type, slideId) => {
          if (type === "COVER_IMPRESSION") {
            if (seenCovers.current.has(slideId)) return;
            seenCovers.current.add(slideId);
          }
          trackEvent(type, { slideId });
        }} detail={product ? <MarketplaceProduct key={product.id} product={product} quantity={cart.find((line) => line.product.id === product.id)?.quantity ?? 0} cartQuantity={(id) => cart.find((line) => line.product.id === id)?.quantity ?? 0} related={related} categories={store.categories} workspace={isPreview ? undefined : workspaceKey} linkRef={apiRef} preview={isPreview} onBack={closeProduct} onAdd={addToCart} onDecrease={decrease} onOpenProduct={openProduct} onBuyNow={buyNow} /> : undefined} /> : <StoreHome
        store={store}
        cart={cart}
        query={query}
        categoryId={categoryId}
        searching={searching}
        onQueryChange={setQuery}
        onCategoryChange={setCategoryId}
        onOpenCart={openCart}
        onOpenProduct={openProduct}
        onAdd={addToCart}
        onDecrease={decrease}
        onLoadMore={() => void loadMore()}
        onCoverEvent={(type, slideId) => {
          if (type === "COVER_IMPRESSION") {
            if (seenCovers.current.has(slideId)) return;
            seenCovers.current.add(slideId);
          }
          trackEvent(type, { slideId });
        }}
      />}

      {count > 0 && !sheet && !product ? (
        <div className="fixed inset-x-0 bottom-0 z-40 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-4 lg:inset-x-auto lg:bottom-5 lg:right-6 lg:w-[22rem] lg:px-0 lg:pb-0">
          <button
            type="button"
            className="mx-auto flex h-12 w-full max-w-xl items-center gap-2 rounded-2xl bg-white px-2 text-left shadow-[0_12px_40px_rgba(0,0,0,0.22)] ring-1 ring-zinc-200 transition active:scale-[0.99] sm:h-14 sm:gap-3 sm:px-3 lg:mx-0 lg:max-w-none"
            onClick={openCart}
          >
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl text-white sm:size-11" style={onAccent(store.accentColor)}>
              <ShoppingBag className="size-4 sm:size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[11px] text-zinc-500 sm:text-xs">{count} {count === 1 ? "item" : "items"}</span>
              <span className="block truncate text-sm font-bold sm:text-base">{formatStorePrice(total)}</span>
            </span>
            <span className="shrink-0 rounded-xl px-2.5 py-2 text-xs font-bold text-white sm:px-4 sm:py-2.5 sm:text-sm" style={onAccent(store.accentColor)}>
              Cart
            </span>
          </button>
        </div>
      ) : null}

      {product && !store.marketplace ? (
        <ProductDetailSheet
          product={product}
          quantity={cart.find((line) => line.product.id === product.id)?.quantity ?? 0}
          accent={store.accentColor}
          related={related}
          cart={cart}
          onClose={closeProduct}
          onAdd={addToCart}
          onDecrease={decrease}
          onOpenProduct={openProduct}
        />
      ) : null}

      {sheet ? (
        <CartSheet
          onUngroup={(id) => setCart((current) => ungroupBundle(current, id))}
          cart={cart}
          accent={store.accentColor}
          checkout={sheet === "checkout"}
          recommendations={recommendations}
          suggestions={trendingProducts([...(store.products.bestSellers ?? []), ...(store.products.featured ?? []), ...catalogPool])}
          checkoutForm={
            <CheckoutForm
              apiRef={apiRef}
              workspace={workspaceKey}
              accent={store.accentColor}
              preview={isPreview}
              cart={cart}
              submitting={submitting}
              error={submitError}
              step={checkoutStep}
              onStepChange={setCheckoutStep}
              couponCode={storeCoupon.coupon?.code ?? null}
              skipAutoCoupon={storeCoupon.skipAuto}
              onCouponApply={(code) => {
                storeCoupon.skipAutomatic(false);
                storeCoupon.apply(code, null);
              }}
              onCouponRemove={(automatic) => (automatic ? storeCoupon.skipAutomatic(true) : storeCoupon.clear())}
              recommendations={pickStoreRecommendations(catalogPool, cart, cart.flatMap((line) => line.product.crossSellIds ?? []), { limit: 6 })}
              onAdd={addToCart}
              onlinePayment={Boolean(store.onlinePayment)}
              onlinePaymentProvider={store.onlinePaymentProvider ?? null}
              onSubmit={async (values) => {
                const path = publicOrderLinkApiPath(apiRef, "submit");
                if (!path) {
                  setSubmitError("This store link is not valid.");
                  return;
                }
                setSubmitting(true);
                setSubmitError(null);
                try {
                  const result = await api<{
                    status: string;
                    orderId?: string;
                    items?: Array<{ productId: string; name: string; unitPrice: number; quantity: number }>;
                    orderNumber?: string | null;
                    total?: number;
                    advanceAmount?: number;
                    codAmount?: number;
                    paymentMethod?: string;
                    returnPolicy?: string;
                    onlinePayment?: OnlinePaymentHandle;
                  }>(path, {
                    method: "POST",
                    body: JSON.stringify({
                      ...values,
                      clientRequestId: submissionId(),
                      ...cartRequest(cart),
                      couponCode: storeCoupon.coupon?.code ?? null,
                      skipAutoCoupon: storeCoupon.skipAuto,
                      payOnline: Boolean(store.onlinePayment),
                      ...(store.onlinePayment ? { returnUrl: window.location.href } : {}),
                    }),
                  });
                  sessionStorage.removeItem(`postbus-store-submit:${workspaceKey}`);
                  submissionIdRef.current = null;
                  if (values.saveAddress) rememberBuyerPhone(workspaceKey, extractIndiaMobileDigits(values.phone));
                  setCart([]);
                  setSheet(null);
                  setCheckoutStep("details");
                  // A coupon is used once per order; the next visit starts clean.
                  storeCoupon.clear();
                  storeCoupon.skipAutomatic(false);
                  const receipt: StoreOrderReceipt = {
                    orderNumber: result.orderNumber ?? "",
                    total: Number(result.total ?? 0),
                    advanceAmount: Number(result.advanceAmount ?? 0),
                    codAmount: Number(result.codAmount ?? 0),
                    paymentMethod: result.paymentMethod ?? "Prepaid",
                    returnPolicy: result.returnPolicy ?? summarizeReturnPolicy(cart.map((line) => line.product.returnAvailable !== false)).label,
                    onlinePayment: result.onlinePayment ?? null,
                    customer: { name: values.customerName, phone: extractIndiaMobileDigits(values.phone) ?? values.phone },
                  };
                  setOrderReceipt(receipt);
                  if (receipt.onlinePayment) {
                    try {
                      sessionStorage.setItem(receiptKey, JSON.stringify({ ...receipt, onlinePayment: { ...receipt.onlinePayment, session: null, error: null } }));
                    } catch {
                      // storage unavailable: the receipt still shows in this page view
                    }
                  }
                  if (result.orderId) emitStoreEvent(workspaceKey, commerceEvent("purchase", { eventId: `order:${result.orderId}`, transactionId: result.orderId, value: Number(result.total ?? 0), items: result.items?.map((item) => ({ item_id: item.productId, item_name: item.name, price: item.unitPrice, quantity: item.quantity })) }));
                  trackEvent("PURCHASE", { value: Number(result.total ?? 0) });
                } catch (error) {
                  setSubmitError(error instanceof Error ? error.message : "Could not submit this order. Please try again.");
                } finally {
                  setSubmitting(false);
                }
              }}
            />
          }
          checkoutStep={checkoutStep}
          onClose={() => {
            setSheet(null);
            setSubmitError(null);
            setCheckoutStep("details");
          }}
          onCheckout={() => {
            setProduct(null);
            setCheckoutStep("details");
            setSheet("checkout");
            trackEvent("CHECKOUT_STARTED", { value: total });
          }}
          onBack={() => {
            setCheckoutStep("details");
            setSheet("cart");
          }}
          onAdd={addToCart}
          onDecrease={decrease}
          onRemove={(productId) => setCart((current) => current.filter((line) => line.product.id !== productId))}
        />
      ) : null}
      {store.marketplace ? <StoreTracking workspace={workspaceKey} config={store.tracking} preview={isPreview} /> : null}
    </div>
  );
}
