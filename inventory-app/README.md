# Inventory + Shopify Sync (Vite React + Firebase)

This app is a starter inventory platform with:

- **Vite + React frontend**
- **Firebase Firestore product database**
- **Transactional stock adjustments**
- **Shopify order ingestion + stock-on-hand (SOH) push**

## What is implemented

### 1) Product database

Firestore collections:

- `products` - master SKU records and current SOH
- `orders` - imported Shopify orders and processing state
- `inventoryMovements` - immutable stock delta history

### 2) Transactional stock handling

Inventory updates happen inside Firestore transactions:

- Manual `+/-` stock adjustments in UI
- Shopify order application (decrement SOH from ordered quantities)
- Idempotency guard: orders are skipped if already `inventoryApplied`

This prevents race conditions and helps guarantee consistent SOH.

### 3) Shopify integration

Firebase Functions endpoints:

- `shopifyOrderCreatedWebhook` - validates webhook HMAC and applies inventory transactionally
- `syncShopifyOrders` - pulls orders from Shopify and applies inventory updates
- `syncStockToShopify` - pushes Firestore SOH back to Shopify inventory levels

Both sync endpoints can be protected via `SYNC_API_KEY` (`x-sync-token` header).

## Setup

### Prerequisites

- Node.js 20+
- Firebase project (Firestore enabled)
- Shopify Admin API credentials

### 1) Frontend env

```bash
cp .env.example .env.local
```

Populate all `VITE_FIREBASE_*` values and set:

- `VITE_FUNCTIONS_BASE_URL` (your deployed functions base URL)
- `VITE_SYNC_API_KEY` (must match backend `SYNC_API_KEY`, optional)

### 2) Backend env (functions)

```bash
cp functions/.env.example functions/.env
```

Set:

- `SHOPIFY_SHOP`
- `SHOPIFY_ADMIN_ACCESS_TOKEN`
- `SHOPIFY_WEBHOOK_SECRET`
- `SHOPIFY_API_VERSION`
- `SHOPIFY_LOCATION_ID` (optional fallback)
- `SYNC_API_KEY` (optional)

### 3) Install dependencies

```bash
npm install
cd functions && npm install
```

### 4) Run frontend

```bash
npm run dev
```

### 5) Deploy backend

From this folder:

```bash
firebase deploy --only functions,firestore
```

## Usage notes

- Create products in the UI using unique SKUs.
- Optional Shopify fields per product:
  - `shopifyInventoryItemId`
  - `shopifyLocationId`
- Use sync buttons in the UI to:
  - pull Shopify orders
  - push current SOH to Shopify

## Security and production hardening checklist

- Replace broad Firestore rule (`request.auth != null`) with role-based rules.
- Add Firebase Auth and claims-based authorization.
- Add retries/backoff for Shopify API rate limits.
- Add order cancel/refund compensation logic.
- Add tests for transaction behavior and webhook signature validation.
