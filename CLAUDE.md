# CLAUDE.md — Pincer Ordering System

## Project Overview

**Pincer** is a QR-based food ordering platform for restaurants in the Dominican Republic. Customers scan QR codes to view menus, place orders, and pay with credit card (Azul gateway). Each restaurant gets its own dashboard to manage orders, menu items, shifts, and analytics.

**Owner/Developer:** Tamayo Belliard
**Domain:** pincerweb.com (live, on Vercel)
**Status:** Production — multi-tenant, payments live, Android app deployed

### Active Clients
- **Mr. Sandwich** (`mrsandwich`) — First client, pilot completed
- **Square One** (`squareone`) — Second client, uses `SQUAREONE_TEST` merchant for test-mode payments

---

## Architecture

### Tech Stack
- **Frontend:** HTML / CSS / Vanilla JavaScript (no frameworks, no build tools)
- **Backend:** Vercel Serverless Functions (Node.js ESM, `api/` directory)
- **Database:** Supabase (`tcwujslibopzfyufhjsr.supabase.co`)
- **Payments:** Azul with mTLS + 3D Secure (fully integrated)
- **Push Notifications:** Firebase Cloud Messaging (FCM) — web + Android native
- **Email:** Resend (`info@pincerweb.com`)
- **AI:** Anthropic Claude API (chatbot, menu extraction, weekly insights)
- **WhatsApp:** Twilio webhook for promotion creation
- **reCAPTCHA:** Google reCAPTCHA v3 on login + signup
- **Android App:** Separate repo (`pincer-dashboard-android`), WebView-based with native FCM

### Single Repo Structure
```
Pincer-web/
  index.html                    # Marketing landing page
  vercel.json                   # Routes, headers, crons, CSP
  rls.sql                       # All Supabase schema + RLS policies
  firebase-messaging-sw.js      # Service worker (FCM + PWA caching)
  certs/                        # Azul mTLS certificates (gitignored)
  api/                          # 30+ Vercel serverless functions
  dashboard/index.html          # Restaurant staff dashboard
  menu/index.html               # Customer-facing menu
  admin/index.html              # Pincer super-admin panel
  login/index.html              # Restaurant login
  signup/index.html             # New restaurant onboarding
  change-password/index.html    # Password change flow
  politicas/                    # Legal pages (privacy, returns, security, delivery)
```

### URL Routing (vercel.json)
- `/:slug` — Customer menu for restaurant
- `/:slug/dashboard` — Staff dashboard
- `/admin` — Pincer super-admin
- `/login`, `/signup`, `/change-password` — Auth flows
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

Key columns on `restaurant_users`: `restaurant_slug`, `plan` (free/premium), `trial_expires_at`, `azul_merchant_id`, `order_types` (array), `delivery_fee`, `menu_style` (JSON theme), `chatbot_personality`, `failed_login_attempts`, `locked_until`.

---

## API Endpoints

### Auth & Sessions
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/auth` | POST | reCAPTCHA | Login, returns httpOnly cookie |
| `/api/logout` | POST | Cookie/header | Invalidates session, clears cookie |
| `/api/change-password` | POST | Session | Change password (forced or voluntary) |
| `/api/verify-session.js` | (shared) | — | `getRestaurantToken()`, `getAdminToken()`, `hashToken()`, `verifyRestaurantSession()` |

### Payments (Azul)
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/payment` | POST | None (public) | Process credit card via Azul mTLS + 3DS |
| `/api/3ds?action=callback` | POST | None | 3DS challenge callback from Azul |
| `/api/3ds?action=continue` | POST | None | Continue after 3DS method |
| `/api/3ds?action=method-notify` | POST | None | 3DS method notification |
| `/api/3ds?action=status` | GET | None | Poll 3DS session status |

### Restaurant Management
| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/update-settings` | PATCH | Session | Update restaurant profile |
| `/api/shift-report` | POST | Session | Generate PDF shift report |
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

Comprehensive security audit completed (March 2026). Key measures:

- **Session tokens:** SHA-256 hashed before storage. Raw token only in httpOnly cookies.
- **Password hashing:** bcrypt cost factor 12
- **Account lockout:** 5 failed attempts = 15-minute lock
- **Session regeneration:** All existing sessions deleted on login
- **Rate limiting:** Hybrid in-memory + Supabase distributed (`rate_limits` table)
- **Fraud detection:** `payment_audit` table with IP/BIN velocity checks (3 failed/IP/hr, 10 orders/BIN/hr, 5 orders/IP/30min)
- **Cross-tenant isolation:** All DB queries scoped to `session.restaurant_slug`
- **Content-Type validation:** `requireJson()` on all POST/PATCH endpoints
- **EXIF stripping:** Logo uploads stripped of EXIF/GPS metadata
- **SRI hashes:** On all CDN scripts (Firebase, html2canvas, qrcode.js)
- **CSP headers:** Full Content-Security-Policy in vercel.json (includes `unsafe-inline`)
- **Timing-safe comparison:** Twilio webhook signature uses `crypto.timingSafeEqual`
- **Error masking:** `error.message` never exposed in production responses
- **Cache control:** API responses have `no-store, no-cache, private`
- **GitHub Actions:** Weekly `npm audit --audit-level=high`
- **Environment check:** Warns if `NODE_ENV=development` points to production Supabase

### Known Security Limitations
- CSP still allows `unsafe-inline` and `unsafe-eval` (required by inline JS in HTML monoliths)
- Card data passes through server (Azul requires mTLS, no client-side tokenization available)
- PCI SAQ D scope (not SAQ A) due to server-side card handling
- Supabase anon key exposed in frontend (mitigated by RLS, but `products` and `orders` have permissive policies)

---

## Payment Flow (Azul)

1. Client sends card data to `/api/payment`
2. Server validates fields, runs fraud checks, looks up per-restaurant `azul_merchant_id`
3. Server sends to Azul via mTLS (`certs/azul-chain.pem` + `certs/azul-key.pem`)
4. Azul responds: frictionless approval (IsoCode 00), 3DS method required, or challenge required
5. For 3DS: client renders hidden iframe or challenge redirect, callbacks hit `/api/3ds`
6. Test mode: `azul_merchant_id = 'SQUAREONE_TEST'` simulates approval without hitting Azul

Card data is never stored or logged. mTLS certificates are in `certs/` (gitignored).

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
- **Customer chatbot** (`/api/waiter-chat`): 5 personalities (`dominicano`, `habibi`, `casual`, `formal`, `playful`). Aware of menu, hours, open/closed status. Can add items to cart via `[ADD_TO_CART:]` syntax.
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
- `AZUL_AUTH1` / `AZUL_AUTH2` / `AZUL_MERCHANT_ID` — Payment processing
- `FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` — Push notifications
- `RESEND_API_KEY` — Transactional email
- `RECAPTCHA_SECRET_KEY` — Login/signup protection
- `CRON_SECRET` — Cron job auth

**IMPORTANT:** Use a separate Supabase project for development. The `env-check.js` module warns if `NODE_ENV=development` is pointed at production.

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

## Deployment

- Push to `main` branch on GitHub auto-deploys via Vercel
- Domain: `www.pincerweb.com` (Vercel)
- SSL: Managed by Vercel
- Azul certs in `certs/` directory (must be present in Vercel file system)

---

## DB Migrations

All schema changes are documented in `rls.sql`. After code changes that require DB updates:
1. Copy the relevant SQL from `rls.sql`
2. Run in Supabase SQL Editor
3. Verify with a test query

**Pending migrations (as of March 2026):**
- `ALTER TABLE restaurant_sessions RENAME COLUMN token TO token_hash`
- `ALTER TABLE admin_sessions RENAME COLUMN token TO token_hash`
- `CREATE TABLE payment_audit (...)` with indexes
- After running: invalidate all existing sessions (users must re-login)

---

## Known Technical Debt

1. **HTML monoliths** — `dashboard/index.html` is 65K+ tokens. Each page has all JS inline. Makes CSP hardening difficult.
2. **Products/orders anon write** — Dashboard uses Supabase anon key for real-time operations (sold-out toggle, order status). Should migrate to authenticated API endpoints.
3. **No automated tests** — Zero test coverage. Only manual testing and `scripts/stress-test.js`.
4. **PCI SAQ D scope** — Card data transits server. Should evaluate Azul Payment Page (redirect) for SAQ A when re-certification is possible.
5. **Legacy files** — `restaurant.html`, `_backups/` directory still exist.
6. **Single Supabase service role key** — All endpoints share one key with full DB access. No granular permissions.

---

## What Was Being Worked On (March 2026)

### Completed
- Full 30-rule security audit implementation (5 batches)
- Cross-tenant authorization hardening
- Android app universal login flow (dynamic slug detection)
- Android FCM token registration with session auth
- Fraud detection system for payments
- Hashed session tokens (SHA-256)

### Next Steps When Resuming
1. **Run pending SQL migrations** in Supabase (token_hash rename + payment_audit table)
2. **Evaluate Azul Payment Page** — Move to SAQ A compliance when possible
3. **Extract inline JS** from HTML monoliths — Enable strict CSP
4. **Migrate dashboard writes** to authenticated API endpoints (products, orders, store_settings)
