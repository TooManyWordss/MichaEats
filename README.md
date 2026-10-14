# MichEats — Kiosk-Based Food Ordering & POS System

A self-hosted canteen system built for the study *"Development of a Kiosk-Based Food Ordering
System to Reduce Queue Lengths in a School Canteen"* (St. Michael's College of Iligan, BED).

It follows the process flow in Chapter 3:

**Order placement (kiosk / phone)** → **order transmission** → **order management (admin)** →
**food preparation (kitchen display)** → **order status update** → **payment at cashier (POS)** →
**order notification (public display / phone)** → **data collection for the study**

## Run it on Vercel (online)

1. On [vercel.com](https://vercel.com) choose **Add New → Project**, import this GitHub repository, and click **Deploy**
   (no settings to change; `vercel.json` already configures it).
2. In the project, open **Storage → Create Database → Upstash (Redis)**. Pick the free plan and connect it to this project.
   This adds the `KV_REST_API_URL` / `KV_REST_API_TOKEN` environment variables.
3. **Deployments → ⋯ → Redeploy** so the app picks up the database.
4. Open the site and change the staff PIN right away (Admin → Settings), since the site is public. Optionally set a
   `STAFF_PIN` environment variable *before* first use to start with your own PIN.

Every screen polls the server every 2 seconds (every 15 seconds when the tab is hidden). The free Upstash plan
has a monthly command limit, so close screens you aren't using during the trial.

Dates and order numbers follow Philippine time (`Asia/Manila`); set `APP_TIMEZONE` to change it.

## Run it on a laptop (offline, same Wi-Fi)

Requires [Node.js](https://nodejs.org) 20 or newer. There is nothing to install.

```bash
cd MichaEats
npm start
```

The terminal prints two addresses: one for this computer and one for other devices on the same Wi-Fi
(for example `http://192.168.1.20:3000`). Default staff PIN: **1234** (change it in Admin → Settings).

## Screens (one device each)

| Screen | URL | Used by |
|---|---|---|
| Self-service kiosk | `/#/kiosk` | Students and teachers (touchscreen) |
| Phone ordering | `/#/order` | Students (Android app) |
| Track order | `/#/track` | Students |
| Cashier POS | `/#/pos` | Cashier (PIN) |
| Preparation display | `/#/kitchen` | Canteen staff (PIN) |
| Public display | `/#/display` | TV / monitor facing the line |
| Admin & research | `/#/admin` | Researchers / admin (PIN) |

The kiosk and the public display run full-screen with no menu bar. To leave either one,
**triple-tap the top-left corner**. Put the kiosk browser in full-screen mode (F11, or Chrome's kiosk mode).

### Cashier POS
- **Collect payment**: type the student's order number and press Enter. Tap a bill (₱20 to ₱1000) or
  **Exact**; the change is computed automatically. Then mark the order paid and print a receipt if needed.
- **Walk-in sale**: ring up an order directly for students who don't use the kiosk. It goes to the kitchen as well.
- **Pickup**: orders the kitchen has marked ready. Food can only be marked claimed after it is paid.

Payment is cash only, as defined in the study's scope (no digital payments, inventory, or financial reporting).

## Research data (Admin → Research)

1. **Before the trial**, set the phase to **Before (manual)**. Use the queue counter and stopwatches
   to record the current manual process.
2. **During the four-day trial**, switch to **During kiosk trial** and record the same measurements.
3. The **Before vs during** table answers SOP 2.1–2.3: mean ± SD for each phase, % change, and
   Welch's t-test (α = 0.05) for significance.
4. The system also logs data automatically: kiosk transaction time (first item tapped → order confirmed),
   wait until ready, wait until claimed, and per-day order counts by strand.
5. **Export CSV** files open in Excel, Google Sheets, or SPSS.

Kiosk users may optionally choose their strand (HUMSS, ABM, STEM…). No names are collected,
in line with the study's ethical considerations.

## Android app (APK)

`/#/order` is a mobile-friendly web app with a web manifest. To make an APK, wrap the server URL
in a WebView using any website-to-APK tool (e.g. Android Studio WebView template, or Bubblewrap
for a Trusted Web Activity). Students can also just open the URL in Chrome and choose **Add to Home screen**.

## Data

On Vercel, data is stored in Upstash Redis. When run locally, it is stored in `data/db.json`. Either way,
download the CSV exports from Admin → Research after each trial day as a backup.
