# Inventory + Shopify Sync (Vite React + Firebase)

This app is a starter inventory platform with:

- **Vite + React frontend styled with Tailwind CSS**
- **Firebase Firestore product database**
- **Transactional stock adjustments**
- **Shopify OAuth for multi-store installs**
- **Shopify order ingestion + SOH push with retry + throttling**

## What is implemented

### 1) Product database

Firestore collections:

- `products` - master SKU records and current SOH
- `orders` - imported Shopify orders and processing state (store-scoped)
- `inventoryMovements` - immutable stock delta history
- `shopifyStores` - installed stores and access tokens from OAuth
- `shopifyOAuthStates` - short-lived OAuth states

### 2) Transactional stock handling

Inventory updates happen inside Firestore transactions:

- Manual `+/-` stock adjustments in UI
- Shopify order application (decrement SOH from ordered quantities)
- Cancellation reversal (restocks SOH)
- Refund reversal (restocks SOH)
- Idempotency guards for order apply, cancellation restock, and refund processing

This prevents race conditions and helps guarantee consistent SOH.

### 3) Shopify integration

Firebase Functions endpoints:

- `shopifyOAuthStart` - starts OAuth install flow for a shop
- `shopifyOAuthCallback` - exchanges auth code and stores per-shop token
- `shopifyOrderCreatedWebhook` - HMAC validation + transactional order decrement
- `shopifyOrderCancelledWebhook` - HMAC validation + transactional restock
- `shopifyRefundCreatedWebhook` - HMAC validation + transactional refund restock
- `syncShopifyOrders` - pulls orders (single store or all stores)
- `syncStockToShopify` - pushes SOH (single store or all stores)

Sync endpoints support:

- batched processing
- retry with exponential backoff for 429/5xx
- request throttling between Shopify calls
- optional `SYNC_API_KEY` auth (`x-sync-token` header)

## Setup

### Prerequisites

- Node.js 20+
- Firebase project (Firestore enabled)
- Shopify app credentials (OAuth-capable app)

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

- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_SCOPES`
- `SHOPIFY_OAUTH_REDIRECT_URI`
- `SHOPIFY_OAUTH_POST_AUTH_REDIRECT` (frontend URL after OAuth, optional)
- `SHOPIFY_WEBHOOK_SECRET`
- `SHOPIFY_API_VERSION`
- `SHOPIFY_SYNC_BATCH_SIZE` (optional)
- `SHOPIFY_SYNC_BATCH_DELAY_MS` (optional)
- `SHOPIFY_REQUEST_DELAY_MS` (optional)
- `SHOPIFY_LOCATION_ID` (optional fallback)
- `SYNC_API_KEY` (optional)

Legacy fallback vars are also supported if you need single-store mode:

- `SHOPIFY_SHOP`
- `SHOPIFY_ADMIN_ACCESS_TOKEN`

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

1. Connect each store from the frontend with **Connect store via OAuth**.
2. Create products with unique SKUs.
3. Optionally set per-store mapping values:
   - `shopifyInventoryItemId`
   - `shopifyLocationId`
4. Use sync controls to run:
   - order sync (store-specific or all stores)
   - SOH push (store-specific or all stores)

## Firestore role-based access model

`firestore.rules` now uses custom claims:

- `admin`
- `inventory_manager`
- `inventory_staff`
- `inventory_auditor`

Collection access:

- `products`: read by all inventory roles, write by admin/manager
- `orders`, `inventoryMovements`: read by inventory roles, no client writes
- `shopifyStores`: admin only

### Example custom claim assignment

Use the Admin SDK to set claims, for example:

```js
await auth.setCustomUserClaims(uid, {
  admin: true,
  inventory_manager: true,
});
```

## Production hardening checklist

- Add webhook replay protection storage and timestamp checks.
- Add background job scheduling for large historical backfills.
- Encrypt/rotate Shopify tokens via Secret Manager integration.
- Add automated tests for transaction edge cases and OAuth/webhook handlers.
