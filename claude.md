[CLAUDE.md](https://github.com/user-attachments/files/25291805/CLAUDE.md)# CLAUDE.md — Pincer Ordering System

## Project Overview

**Pincer** is a QR-based food ordering platform built for food trucks and food parks in the Dominican Republic. Customers scan QR codes to view menus, place orders, and pay. Each food truck has its own dashboard to manage orders and menu items.

**Owner/Developer:** Tamayo Belliard  
**First Client:** Mr. Sandwich by Chef Elly  
**Status:** Pilot completed successfully, migrating to production  
**Domain:** pincerweb.com (to be purchased on Namecheap)

---

## Architecture

### Tech Stack
- **Frontend:** HTML / CSS / Vanilla JavaScript (no frameworks)
- **Backend/Database:** Supabase (currently FREE tier — must migrate to Pro for production)
- **Hosting:** Vercel
- **Payments:** Azul (integration pending — technical docs being received)
- **Notifications:** WhatsApp Business API (to be implemented for "order ready" alerts)

### Repository Structure
Two separate GitHub repos:
- **Client-facing app** (currently `index.html`) — menu, ordering, QR landing pages
- **Staff dashboard** (currently `restaurant.html`) — order management per food truck

> **IMPORTANT:** File naming must be updated. Each client (food truck) needs its own named pages, not generic `index.html`/`restaurant.html`. Naming convention TBD but should support multi-tenant scaling.

---

## Customer Flows

### Flow 1: QR from a Food Truck (Direct)
1. Customer scans QR code on the food truck
2. → Landing page explaining how Pincer works
3. → Customer clicks "Ver Menú"
4. → Menu for THAT specific food truck loads
5. → Customer selects items, places order
6. → Pays via Azul
7. → Receives WhatsApp notification when order is ready

### Flow 2: QR from a Food Park (Multi-vendor)
1. Customer scans QR code on table at food park
2. → Landing page explaining how Pincer works
3. → Shows ALL food trucks available at that food park
4. → Customer selects a food truck
5. → Menu for that food truck loads
6. → Customer selects items, places order
7. → Pays via Azul
8. → Receives WhatsApp notification when order is ready

---

## Database (Supabase)

**Project:** `pincer-prod`  
**Org:** tamayobelliard's Org  
**Current Plan:** FREE (must upgrade to Pro before production launch)

### Table: `products`
| Column | Type | Description |
|--------|------|-------------|
| `id` | text (PK) | Product identifier slug (e.g., `cubano`, `club`, `extra_fondue`) |
| `sold_out` | bool | Whether the item is sold out (`TRUE`/`FALSE`) |
| `updated_at` | timestamp | Last update timestamp |

Currently 14 records including: `club`, `cubano`, `extra_fondue`, `extra_mayo`, `extra_salsita`, `extra_tocineta`, `fries`, `pastrami`, `phillie`, `pierna`, `smash`, and others.

### Table: `orders`
| Column | Type | Description |
|--------|------|-------------|
| `id` | int8 (PK) | Auto-incrementing order ID |
| `items` | text | JSON string with order items (e.g., `[{"id":"cubano","name":"Cubano","qty":1,...}]`) |
| `total` | int4 | Total amount in Dominican Pesos (no decimals) |
| `status` | text | Order status (e.g., `ready`) |

### Database Notes
- Items are stored as JSON strings in a text field, not as JSONB or relational
- Totals are stored as integers (pesos without decimals)
- The `products` table only tracks sold-out status, not full product details (prices, descriptions, etc. are hardcoded in the frontend)
- **RLS policies exist** (3 policies shown in dashboard) — review and update for production security
- Consider adding tables for: `restaurants`, `food_parks`, `categories`, `payment_transactions`

---

## Known Bugs (from Pilot)

### BUG-001: Sold-out status not syncing to customer menu
- **Severity:** High
- **Description:** When staff marks a product as "agotado" (sold out) in the dashboard, the change does NOT reflect on the customer-facing menu (`index.html`)
- **Likely cause:** Frontend not polling/subscribing to Supabase `products` table for real-time changes, OR caching issue
- **Fix needed:** Implement Supabase Realtime subscription on the `products` table in the client app, or add periodic polling to refresh sold-out status

---

## Improvements & Features for Production

### Priority 1 — Critical for Launch

1. **Fix sold-out sync bug** (BUG-001)
2. **Azul payment integration**
   - Integrate payment gateway (awaiting technical documentation from Azul)
   - Pincer acts as a "veriphone" — processing payments on behalf of food trucks
3. **Domain setup**
   - Purchase `pincerweb.com` on Namecheap
   - Configure DNS to point to Vercel
   - Set up SSL (Vercel handles this automatically)
4. **Migrate Supabase to Pro plan**
   - Free tier has connection limits, pausing after inactivity, and limited storage
   - Production needs reliable uptime and no cold starts
5. **File/page restructuring for multi-client**
   - Rename generic `index.html` / `restaurant.html` to client-specific names
   - Establish URL routing convention (e.g., `pincerweb.com/mrsandwich/menu`, `pincerweb.com/mrsandwich/dashboard`)

### Priority 2 — UX Improvements

6. **WhatsApp notifications for "order ready"**
   - Replace current in-browser notification (customers close the browser after ordering)
   - Use WhatsApp Business API (via Twilio or Meta directly)
   - Collect customer phone number during order flow
   - Send templated message: "Tu orden #XX en [Food Truck Name] está lista!"

7. **Fix item click area**
   - Currently: only the photo or "+" icon opens the order popup
   - Needed: clicking ANYWHERE on the item card should open the popup

8. **Fix/remove chatbot overlay**
   - The custom-built chatbot widget obstructs the menu view
   - Options: remove it entirely, move it to a less intrusive position, or make it collapsible/hidden by default

9. **Change "Completar Orden" button color**
   - Current: green background with white text (blends into green menu background)
   - Change to: RED background with white text for better visibility and contrast

10. **Restore "Mis Órdenes" section**
    - A section below "Completar Orden" was accidentally deleted in the last version
    - Should show: items ordered in current session, order status, total amount, order number
    - Essential for customers to track their orders

### Priority 3 — Business Features

11. **End-of-day closing / reconciliation**
    - Add "Cierre de Jornada" button in the dashboard
    - Generates a summary: total orders, total payments received, itemized breakdown
    - Allows food truck operators to reconcile Azul payments with system records
    - Should support printing (receipt printer integration)

12. **New menu items and categories for Mr. Sandwich**
    - Client has provided new items and a new food category to add
    - Update both frontend menu and `products` table in Supabase

13. **Multi-tenant architecture planning**
    - Currently single-tenant (Mr. Sandwich only)
    - Need to plan database schema for multiple food trucks and food parks
    - Each food truck gets its own dashboard
    - Food parks show directory of all trucks in that location

---

## Code Conventions

- **Language:** All code is vanilla HTML/CSS/JS — no build tools, no npm for frontend
- **Style:** Keep it simple and readable, prioritize mobile-first design (customers scan QR on phones)
- **Supabase:** Use the Supabase JS client library (`@supabase/supabase-js`) loaded via CDN
- **Currency:** All amounts in Dominican Pesos (DOP), stored as integers (no decimals)
- **Language:** UI is in Spanish for the Dominican market
- **Color scheme:** Current menu uses green as the primary color

---

## Environment & Credentials

- **Supabase Project URL:** `https://tcwujslibopzfyufhjsr.supabase.co` (visible in screenshots)
- **Supabase Dashboard:** `supabase.com/dashboard/project/tcwujslibopzfyufhjsr`
- **Vercel:** Connected to GitHub repos for auto-deployment
- **Azul:** Contract in place, technical integration docs pending

> **SECURITY NOTE:** Never commit Supabase anon/service keys directly in frontend code. Use environment variables in Vercel for sensitive keys.

---

## Deployment

- Push to GitHub → Vercel auto-deploys
- Client app and dashboard are separate Vercel projects (separate repos)
- Custom domain (`pincerweb.com`) needs to be added in Vercel project settings after purchase

---

## Future Considerations

- **Scaling:** As more food trucks onboard, consider migrating from static HTML pages per client to a dynamic system that reads menu data from Supabase
- **Food Park directory:** Build a central landing page per food park showing all participating trucks
- **Analytics:** Track popular items, peak hours, average order value per truck
- **Receipt printing:** Integrate with thermal printers for kitchen tickets and end-of-day reports
- **Offline handling:** Consider service workers for areas with poor connectivity at food parks

