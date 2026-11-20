# Merchant storefronts on `{slug}.postbus.in`

Status (2026-11-20): code complete, tested, **not deployed**. Behind `STOREFRONT_SUBDOMAINS_ENABLED`, which defaults to off.
Migration `20261120130000_storefront_subdomain_namespace.sql` is **applied on production** (2026-11-20).

## How it works

| Request | Result |
| --- | --- |
| `https://tekiom-ventures.postbus.in/` | Store home (rewritten internally to `/store/tekiom-ventures`) |
| `…/products/{slug}`, `…/category/{slug}`, `…/terms` | Same store pages as before |
| `…/track`, `…/?tracking=EE…IN` | That merchant's own tracking page, if they own one with the same label |
| `…/api/*` | Unchanged API, tagged with `x-store-host` |
| `…/dashboard`, `/login`, `/admin`, … | 308 to `https://www.postbus.in/…` (auth cookies stay on www) |
| `…/store/tekiom-ventures/x` on the store host | 308 to `/x` (old in-app links and saved cover CTAs) |
| `https://www.postbus.in/store/tekiom-ventures/x?q` | **301** to `https://tekiom-ventures.postbus.in/x?q` (only for active store slugs) |
| A subdomain that is not a store | Unchanged: tracking page behaviour |
| `{slug}.postbus.in/robots.txt`, `/sitemap.xml` | Per-store robots and sitemap (home, categories, visible products) |

- **Host → merchant:** `proxy.ts` resolves the label to the active `customer_order_links.public_workspace` row
  (`modules/storefront/host-resolver.ts`, 60 s per-process cache, 15 s for misses, invalidated on address change).
  If the lookup fails, it falls back to the old behaviour rather than guessing a store.
- **Tenant isolation:** a store host can only render its own `/store/{slug}` route; links to other stores redirect to
  their host. `x-store-host` / `x-tracking-subdomain` are stripped from every incoming request, so only the proxy sets them.
  Tracking lookups on a store host use the proxy header only, so another merchant's tracking page never appears there.
- **One namespace:** store slugs and tracking subdomains share `*.postbus.in`. The availability checks (both directions) and
  the DB triggers in the migration refuse a label held by a different merchant. Same merchant, same label is allowed (52 of them today).
- **Reserved names:** `RESERVED_STORE_SUBDOMAINS` in `modules/storefront/host.ts` (www, api, admin, dashboard, app, mail, support,
  track, status, cdn, auth, billing, checkout, staging, …). Existing store `test` is grandfathered.
- **Caching:** store pages are `force-dynamic`; the public store API keeps `s-maxage=30`, keyed by host + URL at Cloudflare,
  and the tenant comes from the URL, so a shared cache cannot mix stores.
- **Cookies:** buyer device cookie is host-only, so each store host keeps its own. Supabase auth cookies stay on www.
- **Canonical/SEO:** canonical, Open Graph and JSON-LD URLs are absolute subdomain URLs once the flag is on.

## Production data (read-only check, 2026-11-20)

- 72 active store slugs, 268 tracking pages (10 published). All slugs are DNS-safe.
- 54 labels exist in both tables: 52 belong to the same merchant (the host serves the store, tracking moves to `/track`; only 1 of those
  tracking pages is published, and its old `/?tracking=` links keep working). 2 labels are store A + DRAFT tracking page B:
  the store owns the host; publishing those 2 tracking pages is now refused until they pick another subdomain.

## DNS and SSL: what is verified and what is left

Verified on 2026-11-20:
- `postbus.in` DNS is on **Cloudflare** (`ishaan`/`meilani.ns.cloudflare.com`) and a wildcard record already exists:
  any `*.postbus.in` resolves to Cloudflare's proxy IPs.
- Cloudflare's edge certificate covers `*.postbus.in` and `postbus.in` (Universal SSL). Browsers get valid HTTPS for any first-level subdomain.
- **The origin does not serve unknown subdomains yet:** `https://<random>.postbus.in/` returns **503** from Cloudflare.
  Coolify/Traefik only routes hosts listed on the application (tracking pages are added one by one through the Coolify API,
  which restarts the app each time).

Origin check (2026-11-20, direct to 89.116.34.166): the proxy is **Traefik** (Coolify). `www.postbus.in` has a Let's Encrypt
certificate; an unknown host gets `TRAEFIK DEFAULT CERT` and **503** (no router). Cloudflare passing that 503 through (not 526)
means the zone's SSL mode is currently **Full** (not strict).

### Step-by-step

1. **Cloudflare Origin CA certificate**: Cloudflare → `postbus.in` → SSL/TLS → Origin Server → Create Certificate →
   RSA 2048, hostnames `*.postbus.in` and `postbus.in`, validity 15 years, format PEM. Copy the certificate and private key
   (the key is shown once).
2. **Put it on the server** (SSH to the VPS):
   ```bash
   sudo mkdir -p /data/coolify/proxy/certs
   sudo nano /data/coolify/proxy/certs/postbus-wildcard.crt   # paste certificate
   sudo nano /data/coolify/proxy/certs/postbus-wildcard.key   # paste private key
   sudo chmod 600 /data/coolify/proxy/certs/postbus-wildcard.key
   ```
3. **Find the app's Traefik service name**: Coolify → PostBus application → Configuration → General → *Container Labels*
   (or `docker inspect <app container> | grep traefik.http.services`). Look for
   `traefik.http.services.<SERVICE>.loadbalancer.server.port=3000`; `<SERVICE>` is usually `https-0-mw9larpomkyonxzy1rk3h6jm`.
4. **Add the wildcard router**: Coolify → Servers → (VPS) → Proxy → Dynamic Configurations → add `postbus-wildcard.yaml`:
   ```yaml
   tls:
     certificates:
       - certFile: /traefik/certs/postbus-wildcard.crt
         keyFile: /traefik/certs/postbus-wildcard.key
   http:
     routers:
       postbus-wildcard:
         rule: 'HostRegexp(`^[a-z0-9-]+\.postbus\.in$`)'
         entryPoints: [https]
         service: <SERVICE>@docker
         priority: 1
         tls: {}
       postbus-wildcard-http:
         rule: 'HostRegexp(`^[a-z0-9-]+\.postbus\.in$`)'
         entryPoints: [http]
         middlewares: [redirect-to-https@docker]
         service: <SERVICE>@docker
         priority: 1
   ```
   The rule above is Traefik v3 syntax (current Coolify). On Traefik v2 use
   ``rule: 'HostRegexp(`{sub:[a-z0-9-]+}.postbus.in`)'`` instead (check the version in Proxy → logs or `traefik version`).
   `priority: 1` keeps `www.postbus.in` and each existing tracking host on their own routers. No `certResolver`, so Traefik never
   tries (and fails) an HTTP-01 wildcard order. If the `redirect-to-https@docker` middleware name differs on your server, drop the
   second router: Cloudflare already redirects to HTTPS.
   Do **not** type `*.postbus.in` into the application's Domains field: that attaches Let's Encrypt to a wildcard and fails.
5. **Check the origin** from any machine:
   ```bash
   curl -sk -o /dev/null -w "%{http_code}\n" --resolve zz-test-123.postbus.in:443:89.116.34.166 https://zz-test-123.postbus.in/
   curl -s -o /dev/null -w "%{http_code}\n" https://zz-test-123.postbus.in/
   curl -s -o /dev/null -w "%{http_code}\n" https://www.postbus.in/
   ```
   Expect `200` for all three (an unknown subdomain shows the PostBus tracking page, as today for tracking hosts).
6. **Optional, recommended: Cloudflare SSL/TLS → Full (strict).** Only after step 5 passes. `www` (Let's Encrypt) and the wildcard
   (Origin CA) are both valid under strict. Re-run step 5; a `526` means a certificate is wrong, so switch back to Full.
7. **Migration**: already applied on production (2026-11-20).
8. **Deploy the code with the flag off**: commit and push the branch, deploy in Coolify, and confirm
   `STOREFRONT_SUBDOMAINS_ENABLED` is unset or `false`. Smoke test: dashboard → Inventory → Storefront shows the `.postbus.in` editor,
   and `https://www.postbus.in/store/tekiom-ventures` still loads (no redirect yet).
9. **Switch on**: Coolify → PostBus → Environment Variables → `STOREFRONT_SUBDOMAINS_ENABLED=true` → Restart (no rebuild needed;
   it is read at runtime).
10. **Verify live**:
    ```bash
    curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" "https://www.postbus.in/store/tekiom-ventures?utm_source=test"
    curl -s -o /dev/null -w "%{http_code}\n" https://tekiom-ventures.postbus.in/
    curl -s https://tekiom-ventures.postbus.in/robots.txt
    curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" https://tekiom-ventures.postbus.in/dashboard
    ```
    Expect `301 https://tekiom-ventures.postbus.in/?utm_source=test`, `200`, a robots file pointing at the store sitemap, and
    `308 https://www.postbus.in/dashboard`. Then in a browser on a test store: open a product and a category, add to cart, place a
    COD order, check it appears in Orders, and open `/track` on a merchant host that has a tracking page.

Rollback: set the flag back to `false` (instant, no data change). Old `/store/{slug}` URLs work again without redirects.

## Not covered

- Custom domains (`shop.merchant.com`) are out of scope.
- Renaming a store frees the old label right away; the old subdomain does not redirect (the dashboard warns about this).
- `.localhost` subdomains in dev show `.localhost` as the suffix; production shows `.postbus.in`.
