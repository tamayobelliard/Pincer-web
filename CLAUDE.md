# CLAUDE.md — Pincer Ordering System

## Project Overview

**Pincer** is a QR-based food ordering platform for restaurants in the Dominican Republic. Customers scan QR codes to view menus, place orders, and pay with credit card (Azul gateway). Each restaurant gets its own dashboard to manage orders, menu items, shifts, and analytics.

**Owner/Developer:** Tamayo Belliard
**Domain:** pincerweb.com (live, on Vercel)
**Status:** Production — multi-tenant, payments live with real transactions, Android app deployed

### Active Clients
- **Mr. Sandwich** (`mrsandwich`) — First client, pilot completed, payments live
- **Square One** (`squareone`) — Second client, first real production payment processed March 26, 2026

---

## Architecture

### Tech Stack
- **Frontend:** HTML / CSS / Vanilla JavaScript (no frameworks, no build tools)
- **Backend:** Vercel Serverless Functions (Node.js ESM, `api/` directory)
- **Database:** Supabase (`tcwujslibopzfyufhjsr.supabase.co`)
- **Payments:** Azul with mTLS + 3D Secure 2.0 (production, fully working)
- **Push Notifications:** Firebase Cloud Messaging (FCM) — web + Android native
- **Email:** Resend (`info@pincerweb.com`)
- **AI:** Anthropic Claude API (chatbot, menu extraction, weekly insights)
- **WhatsApp:** Twilio webhook for promotion creation
- **reCAPTCHA:** Google reCAPTCHA v3 on login + signup
- **Android App:** Separate repo (`pincer-dashboard-android` on Desktop), WebView-based with native FCM

### Single Repo Structure
```
Pincer-web/
  index.html                    # Marketing landing page
  vercel.json                   # Routes, headers, crons, CSP
  rls.sql                       # All Supabase schema + RLS policies
  firebase-messaging-sw.js      # Service worker (FCM + PWA caching)
  certs/                        # Azul mTLS certificates (git-tracked via force-add)
  api/                          # 30+ Vercel serverless functions
  dashboard/index.html          # Restaurant staff dashboard
  menu/index.html               # Customer-facing menu
  admin/index.html              # Pincer super-admin panel
  login/index.html              # Restaurant login
  signup/index.html             # New restaurant onboarding
  change-password/index.html    # Password change flow
  reset-password/index.html     # Forgot password flow
  politicas/                    # Legal pages (privacy, returns, security, delivery)
```

### URL Routing (vercel.json)
- `/:slug` — Customer menu for restaurant
- `/:slug/dashboard` — Staff dashboard
- `/admin` — Pincer super-admin
- `/login`, `/signup`, `/change-password`, `/reset-password` — Auth flows
- Social bots on `/:slug` get redirected to `/api/og?slug=:slug` for OG images

---

## Database Schema

All tables have RLS enabled. API endpoints use service role key (bypasses RLS). Anon key access is restricted by RLS policies.

| Table | Purpose | Anon Access |
|-------|---------|-------------|
| `restaurant_users` | Multi-tenant accounts, settings, plan | Read active only |
| `restaurant_sessions` | Auth sessions (`token_hash`, SHA-256) | None |
| `admin_sessions` | Admin auth sessions (`token_hash`) | None |
| `products` | Menu items per restaurant | Full CRUD |
| `orders` | Customer orders (JSON items, int total DOP) | Read + insert (pending/paid) + update |
| `shifts` | Work shifts with revenue tracking | Read + insert + update |
| `store_settings` | Per-restaurant open/closed status | Read + write |
| `fcm_tokens` | Push notification device tokens | Insert + update |
| `promotions` | WhatsApp-created promotional offers | Read only |
| `page_events` | Analytics tracking | None |
| `chat_messages` | Chatbot conversation history | None |
| `restaurant_insights` | Weekly AI-generated analytics | Read only |
| `rate_limits` | Distributed rate limiting | None |
| `payment_audit` | Fraud detection log (IP, BIN, last4) | None |
| `sessions_3ds` | 3D Secure payment flow state | None |

Key columns on `restaurant_users`: `restaurant_slug`, `plan` (free/premium), `trial_expires_at`, `azul_merchant_id`, `order_types` (array), `delivery_fee`, `menu_style` (JSON theme), `chatbot_personality`, `failed_login_attempts`, `locked_until`, `reset_token_hash`, `reset_token_expires`.

---

## API Endpoints

### Auth & Sessions
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/auth` | POST | reCAPTCHA | Login, returns httpOnly cookie |
| `/api/logout` | POST | Cookie/header | Invalidates session, clears cookie |
| `/api/change-password` | POST | Session | Change password (forced or voluntary) |
| `/api/forgot-password` | POST | reCAPTCHA | Send password reset email via Resend |
| `/api/reset-password` | POST | Token | Reset password from email link |
| `/api/verify-session.js` | (shared) | — | `getRestaurantToken()`, `getAdminToken()`, `hashToken()`, `verifyRestaurantSession()` |

### Payments (Azul)
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/payment` | POST | None (public) | Process credit card via Azul mTLS + 3DS |
| `/api/3ds?action=callback` | POST | None | 3DS challenge callback from Azul |
| `/api/3ds?action=continue` | POST | None | Continue after 3DS method (uses `?processthreedsmethod` endpoint) |
| `/api/3ds?action=method-notify` | POST | None | 3DS method notification from Azul |
| `/api/3ds?action=status` | GET | None | Poll 3DS session status |

### Restaurant Management
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/update-settings` | PATCH | Session | Update restaurant profile |
| `/api/shift-report` | POST | Session | Close shift + generate PDF report |
| `/api/download-report` | POST | Session | Download reports |
| `/api/toggle-promo` | PATCH | Session | Enable/disable promotions |
| `/api/register-device-token` | POST | Session | Register Android FCM token |
| `/api/send-notification` | POST | Webhook secret | FCM push on new order |

### AI Features
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/waiter-chat` | POST | None | Customer AI chatbot (5 personalities) |
| `/api/chat` | POST | Session | Dashboard AI assistant |
| `/api/generate-insights` | Cron | Cron secret | Weekly AI analytics |
| `/api/parse-menu` | POST | Admin | Re-extract menu from images |

### Admin & Onboarding
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/admin?action=...` | Various | Admin session | Super-admin CRUD for restaurants |
| `/api/signup` | POST/PATCH | reCAPTCHA | New restaurant creation + menu upload |
| `/api/send-confirmation-email` | POST | None | Email verification |
| `/api/verify-email` | GET | Token | Confirm email |

### Other
| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/track` | POST | Analytics event logging |
| `/api/og` | GET | OG image generation for social sharing |
| `/api/whatsapp-webhook` | POST | Twilio WhatsApp to promotions |

---

## Security Implementation

Security audit completed (March 2026). Key measures in place:

- **Session tokens:** SHA-256 hashed before storage. Raw token only in httpOnly cookies.
- **Password hashing:** bcrypt cost factor 12
- **Account lockout:** 5 failed attempts = 15-minute lock
- **Session regeneration:** All existing sessions deleted on login
- **Rate limiting:** Hybrid in-memory + Supabase distributed (`rate_limits` table)
- **Cross-tenant isolation:** All DB queries scoped to `session.restaurant_slug`
- **EXIF stripping:** Logo uploads stripped of EXIF/GPS metadata
- **SRI hashes:** On all CDN scripts (Firebase, html2canvas, qrcode.js)
- **CSP headers:** Full Content-Security-Policy in vercel.json (includes Visa/Cardinal for 3DS)
- **Timing-safe comparison:** Twilio webhook signature uses `crypto.timingSafeEqual`
- **Cache control:** API responses have `no-store, no-cache, private`
- **GitHub Actions:** Weekly `npm audit --audit-level=high`
- **Environment check:** Warns if `NODE_ENV=development` points to production Supabase

### Security features reverted during payment debugging (to re-apply later)
- **Fraud detection:** `checkFraud()` + `logPaymentAttempt()` in `fraud-check.js` — was in `payment.js`, reverted to February base for stability
- **Input validation:** Strict regex for cardNumber, expiration, CVC, amount — was in `payment.js`, reverted
- **requireJson():** Content-Type validation on payment endpoint — reverted
- **Error masking:** Generic error messages in payment/3ds endpoints — reverted

### Known Security Limitations
- CSP still allows `unsafe-inline` and `unsafe-eval` (required by inline JS in HTML monoliths)
- Card data passes through server (Azul requires mTLS, no client-side tokenization available)
- PCI SAQ D scope (not SAQ A) due to server-side card handling
- Supabase anon key exposed in frontend (mitigated by RLS, but `products` and `orders` have permissive policies)

---

## Payment Flow (Azul) — PRODUCTION WORKING

### Flow
1. Client sends card data to `/api/payment` (includes `ThreeDSAuth`, `BrowserInfo`, `CardHolderInfo`)
2. Server validates fields, looks up per-restaurant `azul_merchant_id`
3. Server sends to Azul via mTLS (`certs/azul-chain.pem` + `certs/azul-key-prod.pem`)
4. Azul responds: frictionless approval (IsoCode 00), 3DS method required, or challenge required
5. For 3DS Method: client renders hidden iframe, polls for method-notify, calls `/api/3ds?action=continue`
6. **CRITICAL:** The continue request must use `?processthreedsmethod` query param on the Azul URL. `api/3ds.js` builds `AZUL_URL_3DS_METHOD` by appending this to `AZUL_URL` env var.
7. Continue request uses only 4 fields: `Channel`, `Store`, `AzulOrderId`, `MethodNotificationStatus`
8. For Challenge: Cardinal Commerce iframe loads, user authenticates with bank, callback hits `/api/3ds?action=callback`
9. Test mode: `azul_merchant_id = 'SQUAREONE_TEST'` simulates approval without hitting Azul

### Critical Implementation Details
- **Expiration format:** YYYYMM (e.g., "202906" for June 2029)
- **ITBIS:** Calculated as 18% of total, sent in centavos
- **CustomerServicePhone:** Set to Pincer support number
- **`maxDuration: 25`** on `api/payment.js` to prevent Vercel timeout
- **CSP frame-src:** Must include `*.vcas.visa.com` and `*.cardinalcommerce.com` for 3DS iframes
- **Challenge redirect:** `cardinalcommerce.com` must be in domain whitelist validation
- **CReq format:** Sent as single `creq=<base64>` field in POST form to Cardinal Commerce
- **Never add `Amount` to the continue request** — it causes Azul to create a new transaction instead of continuing the existing one
- Card data is never stored or logged. mTLS certificates are in `certs/` (git-tracked via force-add, despite `.gitignore`)

### Certificates
- **Production cert:** `certs/azul-cert.pem` (OU=Produccion, CN=pincerweb.local, expires April 2029)
- **Production key:** `certs/azul-key-prod.pem` (4096-bit RSA, generated with CSR `certs/azul-csr-prod.pem`)
- **Chain:** `certs/azul-chain.pem` (prod cert + BPD-SCA + BPD-RCA)
- **Old cert backup:** `certs/azul-cert-old.pem`, `certs/azul-chain-old.pem`
- **Old key (Desarrollo):** `certs/azul-key.pem` — no longer used

---

## Push Notifications (FCM)

- **Firebase project:** `pincer-app-deda6`
- **Service worker:** `firebase-messaging-sw.js` (version v5)
- **Trigger:** Supabase webhook on `orders` INSERT calls `/api/send-notification`
- **Android:** Native app registers FCM token via `/api/register-device-token` with session auth
- **Zombie cleanup:** Tokens not updated in 30+ days are deactivated
- **Dashboard sound:** Service worker posts `PLAY_ORDER_SOUND` message to trigger audio alert

---

## AI Features

- **Model:** `claude-haiku-4-5-20251001` (fast, cheap)
- **Customer chatbot** (`/api/waiter-chat`): 5 personalities (`dominicano`, `habibi`, `casual`, `formal`, `playful`). Aware of menu, hours, open/closed status. Can add items to cart via `[ADD_TO_CART:]` syntax. Uses `ai_insights.hero_insight` for smarter recommendations.
- **Dashboard AI** (`/api/chat`): Analyzes 14 days of orders, answers business questions
- **Menu extraction** (`signup.js`): Claude Vision extracts items from uploaded menu images/PDFs, picks color theme
- **Weekly insights** (`/api/generate-insights`): Cron runs Monday 3am, generates analytics summary

---

## Cron Jobs

| Schedule | Endpoint | Purpose |
|----------|----------|---------|
| Daily midnight | `/api/cron/downgrade-trials` | Expire 30-day premium trials |
| Daily 2am | `/api/cron/chatbot-learnings` | Process chatbot conversation data |
| Monday 3am | `/api/generate-insights` | Weekly AI analytics |
| Every 5 min | `/api/cron/cleanup-rate-limits` | Clean rate_limits + expired sessions + old payment_audit |

---

## Environment Variables

See `.env.example` for the full list. Critical ones:
- `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` — Database access
- `ANTHROPIC_API_KEY` — AI features
- `AZUL_URL` — Azul production endpoint (`https://pagos.azul.com.do/WebServices/JSON/default.aspx`)
- `AZUL_AUTH1` / `AZUL_AUTH2` / `AZUL_MERCHANT_ID` — Payment processing
- `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` — Push notifications
- `RESEND_API_KEY` — Transactional email
- `RECAPTCHA_SECRET_KEY` — Login/signup protection
- `CRON_SECRET` — Cron job auth
- `BASE_URL` — `https://www.pincerweb.com` (used for 3DS callback URLs)

**IMPORTANT:** `AZUL_URL` in Vercel must NOT include `?processthreedsmethod` — that is appended by `api/3ds.js` automatically. If you include it, the initial payment request will fail.

---

## Code Conventions

- **No frameworks.** Vanilla HTML/CSS/JS. No npm for frontend, no build step.
- **Mobile-first.** Customers scan QR on phones.
- **Spanish UI.** All user-facing text in Spanish for DR market.
- **Currency:** Dominican Pesos (DOP), stored as integers (no decimals).
- **Timezone:** DR = UTC-4 (no DST). All time logic uses this.
- **API pattern:** Each `api/*.js` exports a default handler. Uses shared helpers from `cors.js`, `rate-limit.js`, `verify-session.js`.
- **Auth pattern:** `getRestaurantToken(req)` checks header first, then cookie. `hashToken()` before any DB query.
- **Supabase access:** Direct REST API calls with service role key (not Supabase JS client).
- **Error responses:** Never expose `error.message` in production. Use generic Spanish error messages.

---

## Cuando modificas `menu/index.html` — checklist de paralelismo

Pincer ahora tiene **dos tipos de menú público**:

1. **Genérico** — `menu/index.html`. Usa el sistema de 6 themes (ver `api/parse-menu.js`). Todos los restaurantes con `custom_template = false` (default) caen acá via el rewrite `/:slug → /menu/index.html`.
2. **Custom (por restaurante)** — `menu/templates/<slug>/index.html`. HTML/CSS/JS aislados por restaurante. Activos: ver lista abajo. Routing vía rewrite específico en `vercel.json`.

La decisión arquitectónica fue **NO compartir JS** entre los dos (aislamiento total). Eso simplifica el ship del primer custom (The Deck) y evita que un cambio en un custom contamine al genérico, pero abre un riesgo de drift: cualquier fix funcional que llegue al genérico debe re-aplicarse a cada custom, y viceversa.

**Antes de mergear un cambio a `menu/index.html`, decide:**

- **CSS/estilos solamente** (colores, spacing, layout, variables) → **no aplica** a customs. Cada uno tiene su propio design system. Merge normal.
- **Lógica funcional** (cart, checkout, chatbot, fail-closed handlers, outage fallback, payment/Azul flow, tracking, localStorage cache, rate limit, session handling, loyalty, promo, store open/closed, order submit, etc.) → **REVISAR** cada custom template para decidir si hay que portar el cambio.
  - En la mayoría de los casos, **sí hay que portar**. Los bugs de lógica (fail-closed, await patches, rate limit splits, etc.) afectan a todos los clientes por igual.
  - Casos donde NO se porta: cambios cosméticos a la UI del carrito genérico (el custom tiene su propia UI).

**Templates custom activos** (mantener esta lista al día al agregar/remover):

- `menu/templates/thedeck/index.html` — The Deck (primer cliente piloto, commit 2026-04-20+).

**Cómo portar un cambio a un custom:**

1. Identificar la función o bloque afectado en `menu/index.html`.
2. Abrir el custom template, ubicar la función equivalente (puede tener nombre ligeramente distinto).
3. Aplicar el mismo cambio conceptual adaptado a la estética del template (ej: si el genérico usa `alert(...)`, el custom puede mostrar el mensaje dentro del design system — mismo comportamiento, distinta presentación).
4. Si el bloque no existe en el custom (porque el custom decidió una arquitectura distinta), decidir: (a) agregarlo, (b) documentar el gap en comentario inline, (c) evaluar si es aceptable no portarlo.
5. Smoke test el custom específicamente antes del merge.

**Trigger de re-evaluación arquitectónica:** cuando haya **3-4 custom templates activos**, considerar refactor a shared JS modules + slot-based templating para reducir duplicación. Antes de eso, el costo de mantener la arquitectura isolate-por-template es menor que el costo de una abstracción prematura. Razón: con 1 template custom no sabemos cuál sería la abstracción correcta; con 3-4 reales hay data suficiente para diseñarla bien.

---

## Deployment

- Push to `main` branch on GitHub auto-deploys via Vercel
- Domain: `www.pincerweb.com` (Vercel)
- SSL: Managed by Vercel
- Azul certs in `certs/` directory (git-tracked via `git add -f`, despite `.gitignore` listing `certs/`)

---

## Android App

- **Repo:** `pincer-dashboard-android` (on Desktop, not git-initialized)
- **Architecture:** WebView loading `https://www.pincerweb.com/login`
- **FCM:** Native Firebase messaging with `PincerFirebaseMessagingService.kt`
- **Screen orientation:** `fullSensor` (free rotation for tablets)
- **Config changes:** `orientation|screenSize|screenLayout|smallestScreenSize` — prevents Activity recreation on rotation
- **Build:** Open in Android Studio, Sync Gradle, Build APK

---

## DB Migrations

All schema changes are documented in `rls.sql`. After code changes that require DB updates:
1. Copy the relevant SQL from `rls.sql`
2. Run in Supabase SQL Editor
3. Verify with a test query

**Completed migrations:**
- `reset_token_hash` and `reset_token_expires` columns on `restaurant_users`
- `payment_audit` table with indexes
- `sessions_3ds` table
- `token` → `token_hash` rename on `restaurant_sessions` and `admin_sessions`

---

## Known Technical Debt

1. **HTML monoliths** — `dashboard/index.html` is 65K+ tokens. Each page has all JS inline. Makes CSP hardening difficult.
2. **Products/orders anon write** — Dashboard uses Supabase anon key for real-time operations (sold-out toggle, order status). Should migrate to authenticated API endpoints.
3. **No automated tests** — Zero test coverage. Only manual testing.
4. **PCI SAQ D scope** — Card data transits server. Should evaluate Azul Payment Page (redirect) for SAQ A when re-certification is possible.
5. **Single Supabase service role key** — All endpoints share one key with full DB access. No granular permissions.
6. **Security features reverted** — Fraud detection, input validation, requireJson, and error masking were reverted from `payment.js` during production debugging. Need to re-apply carefully without breaking the payment flow. The February base (commit 856d195) is the current production state for payment/3ds.
7. **ITBIS hardcoded in some places** — Frontend now calculates 18% ITBIS but some edge cases may still send "000".

---

## What Was Completed (March 2026)

### Azul Payment Integration — PRODUCTION LIVE
- Production certificate (OU=Produccion) generated and deployed
- Full 3DS 2.0 flow working: payment → 3DS Method → challenge → approval
- Root cause of production failures: `AZUL_URL` env var overriding `?processthreedsmethod` endpoint
- CSP updated for Visa (`vcas.visa.com`) and Cardinal Commerce (`cardinalcommerce.com`) iframes
- ITBIS calculated as 18% instead of hardcoded "000"
- CustomerServicePhone added to Azul requests
- First real transaction: March 26, 2026 (Square One, RD$140)

### Forgot Password Flow
- `api/forgot-password.js` — generates reset token, sends email via Resend
- `api/reset-password.js` — validates token, updates password
- `reset-password/index.html` — dual-mode page (request email / set new password)
- Link added to login page

### Dashboard Fixes
- Shift close bug fixed: `topProducts` field was being sent to Supabase PATCH but doesn't exist in `shifts` table
- PATCH now explicitly lists DB columns and verifies success
- Sidebar hidden by default on tablets (breakpoint raised to 1024px)
- Duplicate "Pincer" text removed from login page

### Android App
- Screen orientation: `fullSensor` for free tablet rotation
- `configChanges` added to prevent Activity recreation on rotation

### Other
- Legacy files removed: `restaurant.html`, `_backups/` directory
- `restaurant_insights` query fixed: `ai_insights.hero_insight` instead of nonexistent `summary_text`
- `api/track.js` fix: await Supabase insert before responding to prevent timeout aborts

---

## Session of April 11, 2026 — 3DS Method/Challenge fixes

The frictionless 3DS path has been working since March 26, 2026 (Square One first real payment). But the **3DS Method + Challenge path was completely broken** in latent ways that never surfaced until a card requiring full 3DS authentication was tested. This session traced and fixed every bug along the chain. Thirteen commits, all in production. Validated end-to-end except for the final approved transaction (the last test failed with `VALIDATION_ERROR:CVC` — a typo, not a code bug).

### Bugs fixed in this session (all in production)

1. **`api/3ds.js:108` — `AZUL_URL` undefined in `handleCallback`** — referenced a variable that did not exist in the file. Latent `ReferenceError`. Replaced with `AZUL_BASE`.
2. **`api/payment.js` — `requireJson` Content-Type validation** — re-applied (was reverted in March debugging).
3. **`api/payment.js` + `api/3ds.js` — error masking on catch** — re-applied (was reverted).
4. **`api/payment.js` — strict input validation** — re-applied (regex for cardNumber, expiration, cvc, amount).
5. **`vercel.json` CSP `frame-src`** — was missing `'self'`. Browsers blocked the bank's iframe from POSTing to `pincerweb.com/api/3ds?action=method-notify`. Added `'self'`.
6. **`vercel.json` `X-Frame-Options: DENY` global** — blocked the 3DS callback HTML from rendering inside the challenge iframe even with CSP fixed. A surgical override rule for `/api/3ds` did NOT take effect (Vercel header merging behavior unexpected). Resolved by adding `frame-ancestors 'self'` to the global CSP, which modern browsers prioritize over X-Frame-Options.
7. **`menu/index.html:4664` — Safari `iframe.name` set after `appendChild`** — caused `form.target` to fail to resolve the iframe in Safari, sending the form POST to nowhere. Moved name assignment before appendChild.
8. **`api/cors.js` — exact-match origin allowlist** — rejected POSTs from `methodurl.vcas.visa.com` (Visa ACS) with 403 before they could reach `handleMethodNotify`. Added an opt-in `extraAllowedOriginPatterns` regex array to `handleCors`. `api/3ds.js` passes patterns for `*.vcas.visa.com`, `*.cardinalcommerce.com`, `*.azul.com.do`. Scoped to `/api/3ds` only — no global CORS weakening.
9. **`api/3ds.js` `handleCallback` postMessage** — forwarded only `ResponseMessage`, lost `ErrorDescription` and `ResponseCode`. Now includes both so the frontend can show real error reasons.
10. **`menu/index.html` — generic "Pago rechazado por el banco" message** — showed misleading text for any decline. Added `friendlyPaymentError()` helper that maps Azul `ErrorDescription` and `IsoCode` to specific Spanish messages (CVC wrong, card expired, insufficient funds, issuer unavailable, etc.). Used in both the direct payment flow and the 3DS challenge result handler.

### Bot analytics also added this session
- `addItem()` gained a `source` parameter (`'menu'` | `'bot'` | `'mixed'`).
- `cart_add` event and `orders.items` JSON now include `source` per item.
- `orders.session_id` column added (SQL migration run) and populated by both insert flows so orders join cleanly to `page_events`.
- `openPinzer()` gained a `trigger` param (`'user_click'` | `'auto'`); auto-open call sites pass `'auto'` so `chat_open` events can be filtered to real user intent.
- Diagnostic `dbg()` calls added throughout `handle3DSMethod` and `handle3DSChallenge`. `dbg()` now also writes to `console.log` so the browser DevTools captures the full trace.

### Test history this session
| Time | Browser | Card | Result |
|---|---|---|---|
| 09:46 AM | Safari mobile | wife card #1 | popup blanco — frame-src CSP block |
| 17:52 PM | Safari desktop | wife card #1 | popup blanco — Safari iframe.name bug |
| 18:18 PM | Chrome mobile | wife card #1 | challenge appeared, token entered, blank popup — X-Frame-Options + CSP |
| 18:55 PM | Chrome (automated) | wife card #1 | iso 99 — CORS blocked method-notify |
| 19:32 PM | Chrome desktop | wife card #1 | iso 99 — risk scoring after multiple fails |
| 19:38 PM | Safari mobile | wife card #2 | full flow, declined with `VALIDATION_ERROR:CVC` (typo) |

The 19:38 test was the first session in the database with `status: declined`, `method_notification_received: true`, and `has_cres: true` — confirming all 16 steps of the 3DS Challenge flow ran end-to-end.

---

## Paused — Continuing tomorrow (April 12, 2026)

### Immediate next step
**Re-test payment with correct CVC.** The 19:38 PM decline was a CVC typo, not a code bug. Last test of the day was paused intentionally to avoid Azul's risk scoring on the wife's account. Pick up tomorrow with the SAME card, careful CVC entry. If it approves, the 3DS Challenge flow is fully validated and Pincer can advertise full card payment support to clients.

### When Resuming Pincer, Priority Tasks (post 3DS validation):
1. **Programa de lealtad — URGENT (from landing rebrand Apr 15)** — competitors are shipping it and the user flagged this as primordial. The data exists: every order already stores `phone`, which is the customer identity. Build a points system: each paid order grants N points (configurable per restaurant); X points redeem for RD$Y off next order; customer enters their phone at checkout, the menu shows available points + redemption option; dashboard shows top loyal customers. No app, no physical cards — all phone-based. New tables: `loyalty_config` (per restaurant), `loyalty_balance` (phone → points). NOT currently in the landing page — the landing was deliberately kept honest until this ships.
2. **Mejorar el upsell del chatbot** — the current `api/waiter-chat.js` system prompt does light upsell ("sugiere complementos cuando detecte interés"). The landing soft-sells this as "guía y recomienda", which is accurate. To justify stronger copy later, add explicit upsell logic to the prompt: when an item is added, suggest a drink or side; when checkout is near, offer an add-on. Measure via the existing `chatbot_order_completed` event.
3. **Real ROI numbers on landing** — landing currently has no specific RD$/month claims (deliberately removed from the Apr 15 rebrand draft). When we have 3+ months of real data from Square One / Mr. Sandwich on: avg order size, commission savings vs Rappi equivalents, upsell lift from the bot — add a concrete ROI section. Source the numbers from the same queries already drafted in CLAUDE.md's "prep time stats" section, just adapted for revenue.
4. **Quote real de Mr. Sandwich** — landing has no testimonial quote as of Apr 15. Call Chef Elly, ask specifically: "Desde que usan Pincer, ¿qué diferencia han notado? ¿Podemos citarte?". Include number if possible (ahorro en comisiones, pedidos digitales vs antes, etc.). Paste into the existing client card or a new testimonial section.
5. **Re-apply fraud detection to payment.js** — sub-task 1d, the only remaining piece from the original security re-application. `api/fraud-check.js` already exists with `checkFraud()` and `logPaymentAttempt()`. Apply with care: `logPaymentAttempt` must be fire-and-forget, `checkFraud` must fail-open on DB error. Verify `payment_audit` table is writable first.
6. **Android app rebuild** — Build new APK with rotation + configChanges fixes that are sitting in the `pincer-dashboard-android` repo on Desktop. Also update the splash drawable to use the new Pincer wordmark (`i.imgur.com/WEvloMf.png`) instead of the current isotipo.
7. **Evaluate Azul Payment Page** — Move to SAQ A compliance when possible (avoids server-side card handling).
8. **Extract inline JS** from HTML monoliths — Enable strict CSP (remove `unsafe-inline` / `unsafe-eval`).
9. **Migrate dashboard writes** to authenticated API endpoints (products, orders, store_settings — currently use Supabase anon key).
10. **Apple Pay / Google Pay** — UI buttons exist at `menu/index.html:2508-2509` but are not wired to any backend. Selecting them and clicking "Pagar" silently does nothing. Real implementation requires Apple Pay Merchant ID, Apple Pay JS or PaymentRequest API, and Azul backend support for Apple Pay tokens.
11. **Font CSP violation** at `menu/index.html:6154` — embedded `data:` URI font is blocked by `font-src 'self' https://fonts.gstatic.com`. Cosmetic (font fallback works) but should be cleaned up. Either add `data:` to font-src or move the font to a hosted file.
12. **Dead `/api/3ds` header override rule** — already removed in commit `5bf79bf`. Documented here so the surgical-override approach is not retried (Vercel header merging behavior is "last rule wins for duplicate keys", which is the opposite of what was assumed).

### Competitive gaps identified vs Fuudt (analysis Apr 15)
Fuudt (fuudt.com) is the main DR competitor — a digital menu + marketing platform (not ordering/payments). They sit upstream of Pincer on the restaurant's pain stack. They beat us on breadth of menu/marketing features and presentation. We beat them on payments, full ordering flow, conversational AI, and commission-free positioning. The backlog below is ordered by what would close the gap fastest without diluting Pincer's core identity.

**High priority (direct feature gaps):**

13. **More client logos on the landing** — Fuudt shows 6+ restaurant logos (Tua Bar, Agentao, Laiali, Zutros, The Cooks Grilling, Rincón) + a 5-star badge. We show only Mr. Sandwich. Add Square One and any other confirmed clients to the `clients-grid` section, even if just name + city. Target: 3-4 visible clients minimum. High-impact, low-effort.

14. **Mid-tier pricing plan** — current pricing is binary ($0 free vs $50 premium). Fuudt has Starter (free) / Builder ($24.99) / Smarter ($59.99) / Leader ($99.99). Consider a middle "Growth" tier around $25-30/mo with a subset of premium features (e.g., loyalty program + analytics AI assistant but not the full chatbot, or reverse). Gives price-sensitive restaurants an upgrade path before the $50 jump.

15. **SEO blog with 3-5 articles** — Fuudt has articles indexed (QR vs NFC, FB Pixel integration, etc.) which attract organic traffic. We have zero content marketing. Draft topics: "Cómo dejar de pagar 30% a Rappi", "Mesero virtual con IA para restaurantes DR", "WhatsApp para pedidos: del caos al orden", "Pagos con tarjeta en tu QR sin POS extra". Host under `/blog/` or `/recursos/`. No heavy CMS needed — static HTML files are fine given the rest of the codebase is vanilla.

**Medium priority (feature depth):**

16. **Analytics integrations (Google Analytics, FB Pixel, Tag Manager, Clarity)** — Fuudt lets restaurants plug their existing marketing stack. Technical effort is small (just `<script>` tag injection per restaurant config). Field on `restaurant_users` table: `tracking_pixels jsonb` storing IDs. Inject tags in menu page render. Helps acquisition for restaurants that already run ad campaigns.

17. **Time/day-based dynamic menu items** — Fuudt calls this "dynamic products". Breakfast menu auto-hides at 11am, happy hour drinks only 5-7pm. Schema: add `available_hours` and `available_days` columns to `products`. Frontend filters by current DR time. Small but shows product maturity and is asked by most cafes/bars.

18. **Custom product fields** (allergens, spice level, etc.) — Fuudt has this. We have free-text `notes`. Could add `tags jsonb` on products (e.g. `{"spicy": 2, "vegetarian": true, "allergens": ["nuts"]}`). Pairs with bot prompts and filters on the menu.

19. **Video in menu items** — Fuudt supports item videos. We support photos only. Add `video_url` column to `products`, render a small inline autoplay-muted loop in the menu. Helps sell high-margin visual items (pizzas, burgers, cocktails).

**Low priority (nice to have but not blocking):**

20. **Multiple menus per account** — Fuudt pitch for multi-brand operators or food trucks switching locations. Our model is one slug = one restaurant. Revisit when we have enough multi-location clients to justify the schema change.

21. **GeoPush (location-based push)** — Fuudt sends push when customer is near the restaurant. Cool feature, not the dolor that sells Pincer. Skip unless volume demands it.

22. **Live chat widget on pincerweb.com** — Fuudt uses Bitrix24 embedded. We direct to WhatsApp. Ours is arguably better for LatAm, but adding a lightweight chat widget (Crisp, Intercom, or even a Pincer-bot-like) could reduce friction on the landing. Only if analytics show landing visitors bouncing without reaching out.

23. **Visual branding polish** — Fuudt's purple/violet + minimalist feels more established. Our red is distinctive but the overall design could use a polish pass. Not urgent; ship features first, polish the brand when we have a clearer identity to protect.

**Explicitly rejected (do NOT build):**

- **Third-party ads on free tier** — Fuudt monetizes free users with ads. Conflicts with Pincer's premium positioning and the commission-free promise. Don't.
- **Outbound WhatsApp marketing campaigns** — user decided Apr 15 it's not worth the engineering effort right now. Fuudt has this (Leader tier) but we're not chasing it.

### Twilio + Multi-promo (Apr 15)

**24. Twilio WhatsApp production rollout per restaurant.** The current integration lives in `api/whatsapp-webhook.js` and works in Twilio Sandbox. Sandbox limitations that will hurt clients in production:
- Each sender's WhatsApp number must send `join <code>` manually once
- Re-join required if no activity in 72 hours
- Only numbers that joined can interact — not usable with real customers
- Messages carry "Sent from your Twilio trial account" prefix

For production, steps per restaurant:
1. Twilio Console → Messaging → Senders → Request a WhatsApp number (one dedicated number per restaurant, or one shared with multi-routing via restaurant_users.phone match)
2. Verify business with Meta Business Manager (3-5 days)
3. Register templates for any message Pincer INITIATES (confirmations, promos, welcome). Messages the restaurant initiates within a 24h window don't need templates.
4. Update the webhook URL in Twilio to the same `https://www.pincerweb.com/api/whatsapp-webhook` — handler already supports multi-restaurant routing via the `phone` field lookup in `restaurant_users`.
5. Costs: ~$0.005-0.02 per conversation in LatAm, billed by Twilio. Pass-through or absorb as part of Premium tier pricing TBD.

Decision needed before building: shared Pincer WhatsApp number (one inbox, route by phone sender) vs per-restaurant numbers (each restaurant gets its own). Shared is cheaper and simpler; per-restaurant is cleaner branding (customer sees "Mr. Sandwich" not "Pincer"). The webhook already supports either — the `From` number gets mapped to `restaurant_slug` via the `phone` column.

**25. Multiple active promos + carousel popup.** Today the system is hard-limited to ONE active promo per restaurant:
- `api/whatsapp-webhook.js:291-304` deactivates every previously-active promo before activating the new one
- `menu/index.html:6166-6172` loads with `order=created_at.desc&limit=1` — only picks up the latest
- `#promoPopup` in the DOM is a single card with no carousel structure

To support 2-3 active promos with a carousel popup, the work splits into:

Backend (`api/whatsapp-webhook.js`):
- Add a per-restaurant limit (default 2-3) to how many promos can be active at once. New environment config or a `max_active_promos` column on `restaurant_users` (default 2).
- When limit is reached and a new promo is published, deactivate the OLDEST (not all) to make room.
- Add a WhatsApp command like "quitar <nombre>" or "quitar 1" for the owner to manually retire a specific promo without publishing a new one.

Frontend (`menu/index.html`):
- Change the load to `limit=3` (or config) and `order=created_at.desc`.
- Rebuild `#promoPopup` as a carousel: one visible slide at a time, left/right arrows or swipe, dots indicator, optional auto-rotate every 4-5s.
- Each slide keeps current fields (badge, image, title, price, old price, description, CTA button). `_activePromo` becomes an array, and `track('promotion_clicked', ...)` fires for the slide the user actually clicked.
- `track('promotion_viewed')` already exists — keep per-slide tracking so analytics shows which of the two promos got more engagement.

UX decisions the user needs to confirm before implementation:
- Auto-rotate or manual swipe only? (auto-rotate is faster to grab attention, manual is less annoying)
- Dismissing the popup dismisses ALL promos for that session, or just the current slide?
- If there's only one active promo, render it as a single card (no carousel controls) — same as today.

Estimated effort: 1-2 days frontend (carousel component, testing swipe on Safari mobile which has been flaky in this codebase), 2-3 hours backend (relax the auto-deactivate, add limit logic).
