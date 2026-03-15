import axios from "axios";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions/v2";
import { onRequest } from "firebase-functions/v2/https";
import { onMessagePublished } from "firebase-functions/v2/pubsub";

initializeApp();

const db = getFirestore();
const productsRef = db.collection("products");
const ordersRef = db.collection("orders");
const inventoryMovementsRef = db.collection("inventoryMovements");
const shopifyStoresRef = db.collection("shopifyStores");
const shopifyOAuthStatesRef = db.collection("shopifyOAuthStates");

const FUNCTION_OPTIONS = {
  region: "us-central1",
  cors: true,
};

const REGION = "us-central1";
const PUBSUB_TOPICS = {
  ordersCreate:
    process.env.SHOPIFY_PUBSUB_TOPIC_ORDERS_CREATE || "shopify-orders-create",
  ordersCancelled:
    process.env.SHOPIFY_PUBSUB_TOPIC_ORDERS_CANCELLED || "shopify-orders-cancelled",
  refundsCreate:
    process.env.SHOPIFY_PUBSUB_TOPIC_REFUNDS_CREATE || "shopify-refunds-create",
};
const SHOPIFY_PUBSUB_WEBHOOKS = [
  {
    shopifyTopic: "orders/create",
    pubsubTopic: PUBSUB_TOPICS.ordersCreate,
  },
  {
    shopifyTopic: "orders/cancelled",
    pubsubTopic: PUBSUB_TOPICS.ordersCancelled,
  },
  {
    shopifyTopic: "refunds/create",
    pubsubTopic: PUBSUB_TOPICS.refundsCreate,
  },
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toSafeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function chunkArray(values, size) {
  const chunks = [];
  const chunkSize = Math.max(1, size);
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize));
  }
  return chunks;
}

function getBatchSize(value, fallback = 20) {
  return Math.min(100, Math.max(1, toSafeNumber(value, fallback)));
}

function getBatchDelayMs(value, fallback = 250) {
  return Math.max(0, toSafeNumber(value, fallback));
}

function getShopifyRequestDelayMs() {
  return Math.max(0, toSafeNumber(process.env.SHOPIFY_REQUEST_DELAY_MS, 120));
}

function getSyncBatchSize() {
  return getBatchSize(process.env.SHOPIFY_SYNC_BATCH_SIZE, 20);
}

function getSyncBatchDelayMs() {
  return getBatchDelayMs(process.env.SHOPIFY_SYNC_BATCH_DELAY_MS, 250);
}

function getPubSubProjectId() {
  return (
    process.env.SHOPIFY_PUBSUB_PROJECT_ID ||
    process.env.GCLOUD_PROJECT ||
    process.env.GOOGLE_CLOUD_PROJECT ||
    process.env.GCP_PROJECT ||
    ""
  );
}

function buildPubSubAddress(projectId, topicName) {
  if (!projectId) {
    throw new Error(
      "Missing Pub/Sub project id. Set SHOPIFY_PUBSUB_PROJECT_ID (or use GCLOUD_PROJECT).",
    );
  }

  if (!topicName) {
    throw new Error("Pub/Sub topic name is required to build destination URI.");
  }

  return `pubsub://${projectId}:${topicName}`;
}

function sanitizeShopDomain(input) {
  if (!input) {
    return "";
  }
  const trimmed = String(input).trim().toLowerCase();
  const withoutProtocol = trimmed.replace(/^https?:\/\//, "");
  return withoutProtocol.split("/")[0];
}

function toStoreId(shopDomain) {
  return sanitizeShopDomain(shopDomain).replace(/[^a-z0-9]+/g, "_");
}

function shopifyApiVersion() {
  return process.env.SHOPIFY_API_VERSION || "2025-10";
}

function getShopifyAppConfig() {
  if (!process.env.SHOPIFY_API_KEY) {
    throw new Error("Missing SHOPIFY_API_KEY environment variable.");
  }
  if (!process.env.SHOPIFY_API_SECRET) {
    throw new Error("Missing SHOPIFY_API_SECRET environment variable.");
  }
  if (!process.env.SHOPIFY_OAUTH_REDIRECT_URI) {
    throw new Error("Missing SHOPIFY_OAUTH_REDIRECT_URI environment variable.");
  }

  return {
    apiKey: process.env.SHOPIFY_API_KEY,
    apiSecret: process.env.SHOPIFY_API_SECRET,
    redirectUri: process.env.SHOPIFY_OAUTH_REDIRECT_URI,
    scopes:
      process.env.SHOPIFY_SCOPES ||
      "read_orders,read_products,write_inventory,read_inventory",
  };
}

function getWebhookSecret() {
  return process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_API_SECRET || "";
}

function parseJsonBody(req) {
  if (typeof req.body === "object" && req.body !== null) {
    return req.body;
  }

  if (req.rawBody) {
    try {
      return JSON.parse(req.rawBody.toString("utf8"));
    } catch (error) {
      logger.error("Invalid JSON payload.", error);
    }
  }

  return {};
}

function parsePubSubJson(event) {
  const encodedPayload = event?.data?.message?.data;
  if (!encodedPayload) {
    return {};
  }

  try {
    const decoded = Buffer.from(encodedPayload, "base64").toString("utf8");
    return JSON.parse(decoded);
  } catch (error) {
    logger.error("Failed to decode Pub/Sub JSON payload.", error);
    return {};
  }
}

function getPubSubAttributes(event) {
  return event?.data?.message?.attributes || {};
}

function pickFirstDefined(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return "";
}

function compareDigest(expected, actual) {
  const expectedBuffer = Buffer.from(expected, "utf8");
  const actualBuffer = Buffer.from(actual, "utf8");
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function verifyShopifyWebhook(req) {
  const webhookSecret = getWebhookSecret();
  if (!webhookSecret) {
    logger.error("Webhook secret is not configured.");
    return false;
  }

  const headerValue = req.get("x-shopify-hmac-sha256");
  if (!headerValue || !req.rawBody) {
    return false;
  }

  const digest = createHmac("sha256", webhookSecret)
    .update(req.rawBody)
    .digest("base64");
  return compareDigest(digest, headerValue);
}

function verifyOAuthCallback(queryParams) {
  const { apiSecret } = getShopifyAppConfig();
  const receivedHmac = String(queryParams.hmac || "");
  if (!receivedHmac) {
    return false;
  }

  const message = Object.keys(queryParams)
    .filter((key) => key !== "hmac" && key !== "signature")
    .sort()
    .map((key) => `${key}=${Array.isArray(queryParams[key]) ? queryParams[key].join(",") : queryParams[key]}`)
    .join("&");

  const digest = createHmac("sha256", apiSecret).update(message).digest("hex");
  return compareDigest(digest, receivedHmac);
}

function isSyncRequestAuthorized(req) {
  const requiredToken = process.env.SYNC_API_KEY;
  if (!requiredToken) {
    return true;
  }

  return req.get("x-sync-token") === requiredToken;
}

function isRetryableShopifyError(error) {
  const status = error?.response?.status;
  return status === 429 || status >= 500 || error?.code === "ECONNABORTED";
}

function getRetryDelayMs(error, attempt) {
  const retryAfterHeader = error?.response?.headers?.["retry-after"];
  if (retryAfterHeader) {
    const fromHeader = toSafeNumber(retryAfterHeader, NaN);
    if (Number.isFinite(fromHeader)) {
      return fromHeader * 1000;
    }
  }

  return Math.min(30000, 500 * 2 ** (attempt - 1));
}

async function runWithShopifyRetry(operation, label) {
  const maxAttempts = 4;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxAttempts || !isRetryableShopifyError(error)) {
        throw error;
      }

      const delayMs = getRetryDelayMs(error, attempt);
      logger.warn(`${label} failed on attempt ${attempt}, retrying in ${delayMs}ms.`);
      await sleep(delayMs);
    }
  }

  throw new Error(`${label} failed after retries.`);
}

function sanitizeOrderLineItems(lineItems) {
  if (!Array.isArray(lineItems)) {
    return [];
  }

  return lineItems.map((lineItem) => ({
    id: lineItem.id || null,
    sku: String(lineItem.sku || "").trim().toUpperCase(),
    title: lineItem.title || null,
    quantity: toSafeNumber(lineItem.quantity),
    variantId: lineItem.variant_id || null,
  }));
}

function sanitizeRefundLineItems(refundLineItems, fallbackOrderLineItems = []) {
  if (!Array.isArray(refundLineItems)) {
    return [];
  }

  const skuByLineItemId = {};
  for (const orderLineItem of fallbackOrderLineItems) {
    if (orderLineItem?.id && orderLineItem?.sku) {
      skuByLineItemId[String(orderLineItem.id)] = String(orderLineItem.sku)
        .trim()
        .toUpperCase();
    }
  }

  return refundLineItems.map((refundLineItem) => {
    const nestedLineItem = refundLineItem.line_item || {};
    const lineItemId = refundLineItem.line_item_id || nestedLineItem.id || null;
    const fallbackSku = lineItemId ? skuByLineItemId[String(lineItemId)] : "";
    return {
      sku: String(nestedLineItem.sku || fallbackSku || "").trim().toUpperCase(),
      quantity: toSafeNumber(refundLineItem.quantity),
      lineItemId,
    };
  });
}

function getOrderDocId(storeId, orderId) {
  return `${storeId}_${String(orderId)}`;
}

async function resolveStoreContextFromDoc(storeDoc) {
  const data = storeDoc.data();
  return {
    storeId: storeDoc.id,
    shop: data.shop,
    accessToken: data.accessToken,
    defaultLocationId: data.defaultLocationId || process.env.SHOPIFY_LOCATION_ID || null,
    status: data.status || "active",
  };
}

async function getStoresForSync({ storeId, shop }) {
  if (storeId) {
    const snapshot = await shopifyStoresRef.doc(storeId).get();
    if (!snapshot.exists) {
      throw new Error(`Store '${storeId}' was not found.`);
    }
    return [await resolveStoreContextFromDoc(snapshot)];
  }

  if (shop) {
    const normalizedShop = sanitizeShopDomain(shop);
    const inferredStoreId = toStoreId(normalizedShop);
    const snapshot = await shopifyStoresRef.doc(inferredStoreId).get();
    if (!snapshot.exists) {
      throw new Error(`Store '${normalizedShop}' is not installed.`);
    }
    return [await resolveStoreContextFromDoc(snapshot)];
  }

  const storesSnapshot = await shopifyStoresRef.where("status", "==", "active").get();
  const stores = await Promise.all(storesSnapshot.docs.map(resolveStoreContextFromDoc));

  // Backward-compatible fallback for legacy single-store env settings.
  if (stores.length === 0 && process.env.SHOPIFY_SHOP && process.env.SHOPIFY_ADMIN_ACCESS_TOKEN) {
    const fallbackShop = sanitizeShopDomain(process.env.SHOPIFY_SHOP);
    return [
      {
        storeId: toStoreId(fallbackShop),
        shop: fallbackShop,
        accessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
        defaultLocationId: process.env.SHOPIFY_LOCATION_ID || null,
        status: "active",
      },
    ];
  }

  return stores;
}

function getShopifyClientForStore(storeContext) {
  if (!storeContext?.shop || !storeContext?.accessToken) {
    throw new Error(`Store ${storeContext?.storeId || "unknown"} is missing credentials.`);
  }

  return axios.create({
    baseURL: `https://${storeContext.shop}/admin/api/${shopifyApiVersion()}`,
    headers: {
      "X-Shopify-Access-Token": storeContext.accessToken,
      "Content-Type": "application/json",
    },
    timeout: 20000,
  });
}

async function ensurePubSubWebhooksForStore(storeContext) {
  const projectId = getPubSubProjectId();
  const shopify = getShopifyClientForStore(storeContext);

  const webhooksResponse = await runWithShopifyRetry(
    () =>
      shopify.get("/webhooks.json", {
        params: { limit: 250 },
      }),
    `list webhooks for ${storeContext.shop}`,
  );

  const existingWebhooks = Array.isArray(webhooksResponse.data?.webhooks)
    ? webhooksResponse.data.webhooks
    : [];

  const summary = {
    created: 0,
    existing: 0,
    failed: [],
  };

  for (const webhookConfig of SHOPIFY_PUBSUB_WEBHOOKS) {
    const address = buildPubSubAddress(projectId, webhookConfig.pubsubTopic);
    const alreadyExists = existingWebhooks.some(
      (webhook) =>
        String(webhook.topic || "").toLowerCase() === webhookConfig.shopifyTopic &&
        String(webhook.address || "") === address,
    );

    if (alreadyExists) {
      summary.existing += 1;
      continue;
    }

    try {
      await runWithShopifyRetry(
        () =>
          shopify.post("/webhooks.json", {
            webhook: {
              topic: webhookConfig.shopifyTopic,
              address,
              format: "json",
            },
          }),
        `create webhook ${webhookConfig.shopifyTopic} for ${storeContext.shop}`,
      );
      summary.created += 1;
    } catch (error) {
      summary.failed.push({
        topic: webhookConfig.shopifyTopic,
        address,
        error: error.message,
      });
    }
  }

  if (summary.failed.length > 0) {
    throw new Error(
      `Webhook auto-registration had ${summary.failed.length} failure(s): ${summary.failed
        .map((item) => `${item.topic}: ${item.error}`)
        .join("; ")}`,
    );
  }

  return summary;
}

async function findProductBySku(transaction, sku) {
  const productQuery = productsRef.where("sku", "==", sku).limit(1);
  const matchingProducts = await transaction.get(productQuery);
  if (matchingProducts.empty) {
    return null;
  }
  return matchingProducts.docs[0];
}

async function applyOrderToInventory(order, storeContext, source) {
  if (!order?.id) {
    throw new Error("Order is missing an id.");
  }

  return db.runTransaction(async (transaction) => {
    const orderId = String(order.id);
    const orderDocRef = ordersRef.doc(getOrderDocId(storeContext.storeId, orderId));
    const orderDocSnapshot = await transaction.get(orderDocRef);

    if (orderDocSnapshot.exists && orderDocSnapshot.data().inventoryApplied) {
      return {
        orderId,
        skipped: true,
        reason: "already_applied",
      };
    }

    // Cancelled orders should not decrement inventory during initial apply.
    if (order.cancelled_at) {
      transaction.set(
        orderDocRef,
        {
          storeId: storeContext.storeId,
          shop: storeContext.shop,
          shopifyId: orderId,
          name: order.name || null,
          lineItems: sanitizeOrderLineItems(order.line_items),
          unresolvedSkus: [],
          source,
          inventoryApplied: false,
          cancellationRestocked: true,
          cancelledAt: order.cancelled_at,
          createdAt: orderDocSnapshot.exists
            ? orderDocSnapshot.data().createdAt
            : FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );

      return {
        orderId,
        skipped: true,
        reason: "cancelled_order",
      };
    }

    const lineItems = sanitizeOrderLineItems(order.line_items);
    const unresolvedSkus = [];
    let movedItems = 0;

    for (const lineItem of lineItems) {
      if (!lineItem.sku || lineItem.quantity <= 0) {
        continue;
      }

      const productDoc = await findProductBySku(transaction, lineItem.sku);
      if (!productDoc) {
        unresolvedSkus.push({
          sku: lineItem.sku,
          quantity: lineItem.quantity,
          reason: "sku_not_found",
        });
        continue;
      }

      const productData = productDoc.data();
      const currentStock = toSafeNumber(productData.quantityOnHand);
      const nextStock = currentStock - lineItem.quantity;

      if (nextStock < 0) {
        throw new Error(`Insufficient stock for SKU ${lineItem.sku}.`);
      }

      transaction.update(productDoc.ref, {
        quantityOnHand: nextStock,
        updatedAt: FieldValue.serverTimestamp(),
        lastOrderId: orderId,
      });

      transaction.set(inventoryMovementsRef.doc(), {
        productId: productDoc.id,
        sku: lineItem.sku,
        delta: -lineItem.quantity,
        reason: "shopify_order",
        source,
        storeId: storeContext.storeId,
        shop: storeContext.shop,
        orderId,
        createdAt: FieldValue.serverTimestamp(),
      });

      movedItems += 1;
    }

    const existingOrder = orderDocSnapshot.exists ? orderDocSnapshot.data() : null;
    transaction.set(
      orderDocRef,
      {
        storeId: storeContext.storeId,
        shop: storeContext.shop,
        shopifyId: orderId,
        name: order.name || null,
        source,
        lineItems,
        unresolvedSkus,
        financialStatus: order.financial_status || null,
        fulfillmentStatus: order.fulfillment_status || null,
        inventoryApplied: true,
        inventoryAppliedAt: FieldValue.serverTimestamp(),
        movedItems,
        createdAt: existingOrder?.createdAt || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      orderId,
      skipped: false,
      movedItems,
      unresolvedSkus,
    };
  });
}

async function restockCancelledOrder(order, storeContext, source) {
  if (!order?.id) {
    throw new Error("Order is missing an id.");
  }

  return db.runTransaction(async (transaction) => {
    const orderId = String(order.id);
    const orderDocRef = ordersRef.doc(getOrderDocId(storeContext.storeId, orderId));
    const orderDocSnapshot = await transaction.get(orderDocRef);
    const existingOrder = orderDocSnapshot.exists ? orderDocSnapshot.data() : {};

    if (existingOrder.cancellationRestocked) {
      return {
        orderId,
        skipped: true,
        reason: "already_restocked_for_cancellation",
      };
    }

    const lineItems =
      Array.isArray(existingOrder.lineItems) && existingOrder.lineItems.length > 0
        ? existingOrder.lineItems
        : sanitizeOrderLineItems(order.line_items);
    const unresolvedSkus = [];
    let restockedItems = 0;

    for (const lineItem of lineItems) {
      if (!lineItem.sku || lineItem.quantity <= 0) {
        continue;
      }

      const productDoc = await findProductBySku(transaction, lineItem.sku);
      if (!productDoc) {
        unresolvedSkus.push({
          sku: lineItem.sku,
          quantity: lineItem.quantity,
          reason: "sku_not_found",
        });
        continue;
      }

      const productData = productDoc.data();
      const currentStock = toSafeNumber(productData.quantityOnHand);
      const nextStock = currentStock + lineItem.quantity;

      transaction.update(productDoc.ref, {
        quantityOnHand: nextStock,
        updatedAt: FieldValue.serverTimestamp(),
      });

      transaction.set(inventoryMovementsRef.doc(), {
        productId: productDoc.id,
        sku: lineItem.sku,
        delta: lineItem.quantity,
        reason: "shopify_order_cancelled",
        source,
        storeId: storeContext.storeId,
        shop: storeContext.shop,
        orderId,
        createdAt: FieldValue.serverTimestamp(),
      });

      restockedItems += 1;
    }

    transaction.set(
      orderDocRef,
      {
        storeId: storeContext.storeId,
        shop: storeContext.shop,
        shopifyId: orderId,
        source,
        lineItems,
        unresolvedSkus: [...(existingOrder.unresolvedSkus || []), ...unresolvedSkus],
        cancellationRestocked: true,
        cancellationRestockedAt: FieldValue.serverTimestamp(),
        cancelledAt: order.cancelled_at || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      orderId,
      skipped: false,
      restockedItems,
      unresolvedSkus,
    };
  });
}

async function applyRefundToInventory(refund, storeContext, source, orderLineItems = []) {
  const refundId = String(refund?.id || "");
  const orderId = String(refund?.order_id || "");
  if (!refundId || !orderId) {
    throw new Error("Refund payload is missing refund id or order id.");
  }

  return db.runTransaction(async (transaction) => {
    const orderDocRef = ordersRef.doc(getOrderDocId(storeContext.storeId, orderId));
    const orderDocSnapshot = await transaction.get(orderDocRef);
    const orderData = orderDocSnapshot.exists ? orderDocSnapshot.data() : {};
    const processedRefundIds = Array.isArray(orderData.processedRefundIds)
      ? orderData.processedRefundIds
      : [];

    if (processedRefundIds.includes(refundId)) {
      return {
        orderId,
        refundId,
        skipped: true,
        reason: "already_processed",
      };
    }

    const fallbackOrderLineItems =
      Array.isArray(orderLineItems) && orderLineItems.length > 0
        ? orderLineItems
        : Array.isArray(orderData.lineItems)
          ? orderData.lineItems
          : [];
    const refundLineItems = sanitizeRefundLineItems(
      refund.refund_line_items,
      fallbackOrderLineItems,
    );
    const unresolvedSkus = [];
    let restockedItems = 0;

    for (const lineItem of refundLineItems) {
      if (!lineItem.sku || lineItem.quantity <= 0) {
        continue;
      }

      const productDoc = await findProductBySku(transaction, lineItem.sku);
      if (!productDoc) {
        unresolvedSkus.push({
          sku: lineItem.sku,
          quantity: lineItem.quantity,
          reason: "sku_not_found",
        });
        continue;
      }

      const productData = productDoc.data();
      const currentStock = toSafeNumber(productData.quantityOnHand);
      const nextStock = currentStock + lineItem.quantity;

      transaction.update(productDoc.ref, {
        quantityOnHand: nextStock,
        updatedAt: FieldValue.serverTimestamp(),
      });

      transaction.set(inventoryMovementsRef.doc(), {
        productId: productDoc.id,
        sku: lineItem.sku,
        delta: lineItem.quantity,
        reason: "shopify_refund",
        source,
        storeId: storeContext.storeId,
        shop: storeContext.shop,
        orderId,
        refundId,
        createdAt: FieldValue.serverTimestamp(),
      });

      restockedItems += 1;
    }

    const updatedRefundIds = [...processedRefundIds, refundId];
    transaction.set(
      orderDocRef,
      {
        storeId: storeContext.storeId,
        shop: storeContext.shop,
        shopifyId: orderId,
        processedRefundIds: updatedRefundIds,
        lastRefundAt: FieldValue.serverTimestamp(),
        unresolvedSkus: [...(orderData.unresolvedSkus || []), ...unresolvedSkus],
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    return {
      orderId,
      refundId,
      skipped: false,
      restockedItems,
      unresolvedSkus,
    };
  });
}

function extractProductMapping(product, storeContext) {
  const storeMapping = product?.shopifyMappings?.[storeContext.storeId] || null;

  const inventoryItemId = toSafeNumber(
    storeMapping?.inventoryItemId || product.shopifyInventoryItemId,
    NaN,
  );
  const locationId = toSafeNumber(
    storeMapping?.locationId ||
      storeContext.defaultLocationId ||
      process.env.SHOPIFY_LOCATION_ID,
    NaN,
  );

  if (!Number.isFinite(inventoryItemId) || !Number.isFinite(locationId)) {
    return null;
  }

  return {
    inventoryItemId,
    locationId,
  };
}

async function getWebhookStoreContext(req) {
  const shopHeader = sanitizeShopDomain(req.get("x-shopify-shop-domain"));
  return getStoreContextByShopDomain(shopHeader);
}

async function getStoreContextByShopDomain(shopDomain) {
  const fallbackShop = sanitizeShopDomain(process.env.SHOPIFY_SHOP || "");
  const shop = sanitizeShopDomain(shopDomain) || fallbackShop;
  const storeId = toStoreId(shop);

  if (!storeId) {
    throw new Error("Unable to determine store context from webhook.");
  }

  const storeSnapshot = await shopifyStoresRef.doc(storeId).get();
  if (storeSnapshot.exists) {
    return resolveStoreContextFromDoc(storeSnapshot);
  }

  return {
    storeId,
    shop,
    accessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || "",
    defaultLocationId: process.env.SHOPIFY_LOCATION_ID || null,
    status: "active",
  };
}

async function processOrderCreatedPayload(orderPayload, storeContext, sourceLabel) {
  const result = await applyOrderToInventory(orderPayload, storeContext, sourceLabel);

  if (orderPayload.cancelled_at) {
    await restockCancelledOrder(orderPayload, storeContext, `${sourceLabel}_cancelled`);
  }

  if (Array.isArray(orderPayload.refunds)) {
    for (const refund of orderPayload.refunds) {
      await applyRefundToInventory(
        { ...refund, order_id: orderPayload.id },
        storeContext,
        `${sourceLabel}_refund`,
        orderPayload.line_items,
      );
    }
  }

  return result;
}

async function processOrderCancelledPayload(orderPayload, storeContext, sourceLabel) {
  return restockCancelledOrder(orderPayload, storeContext, sourceLabel);
}

async function processRefundPayload(refundPayload, storeContext, sourceLabel) {
  return applyRefundToInventory(refundPayload, storeContext, sourceLabel);
}

function normalizeSku(value) {
  return String(value || "").trim().toUpperCase();
}

function buildImportedProductName(shopifyProduct, variant) {
  const productTitle = String(shopifyProduct?.title || "").trim();
  const variantTitle = String(variant?.title || "").trim();
  if (!variantTitle || variantTitle === "Default Title") {
    return productTitle || "Unnamed Shopify Product";
  }
  if (!productTitle) {
    return variantTitle;
  }
  return `${productTitle} - ${variantTitle}`;
}

function buildStoreMappingFromVariant(shopifyProduct, variant, storeContext) {
  const mapping = {
    productId: String(shopifyProduct?.id || ""),
    variantId: String(variant?.id || ""),
    inventoryItemId: String(variant?.inventory_item_id || ""),
  };

  const fallbackLocationId =
    storeContext?.defaultLocationId || process.env.SHOPIFY_LOCATION_ID || "";
  if (fallbackLocationId) {
    mapping.locationId = String(fallbackLocationId);
  }

  return mapping;
}

async function syncShopifyProductsForStore(storeContext, options = {}) {
  const shopify = getShopifyClientForStore(storeContext);
  const pageDelayMs = getBatchDelayMs(
    options.pageDelayMs,
    getBatchDelayMs(process.env.SHOPIFY_PRODUCT_SYNC_PAGE_DELAY_MS, 200),
  );

  const firestoreProductsSnapshot = await productsRef.get();
  const productsBySku = new Map();
  for (const productDoc of firestoreProductsSnapshot.docs) {
    const product = productDoc.data();
    const normalizedSku = normalizeSku(product.sku);
    if (!normalizedSku) {
      continue;
    }
    productsBySku.set(normalizedSku, {
      id: productDoc.id,
      ref: productDoc.ref,
      data: product,
    });
  }

  const summary = {
    pulledProducts: 0,
    variantsSeen: 0,
    mappedExisting: 0,
    createdProducts: 0,
    skippedNoSku: 0,
  };

  let sinceId = "";
  while (true) {
    const response = await runWithShopifyRetry(
      () =>
        shopify.get("/products.json", {
          params: {
            limit: 250,
            status: "any",
            ...(sinceId ? { since_id: sinceId } : {}),
          },
        }),
      `products fetch for ${storeContext.shop}`,
    );

    const shopifyProducts = Array.isArray(response.data?.products)
      ? response.data.products
      : [];

    if (shopifyProducts.length === 0) {
      break;
    }

    summary.pulledProducts += shopifyProducts.length;

    for (const shopifyProduct of shopifyProducts) {
      const variants = Array.isArray(shopifyProduct.variants)
        ? shopifyProduct.variants
        : [];

      for (const variant of variants) {
        summary.variantsSeen += 1;

        const sku = normalizeSku(variant.sku);
        if (!sku) {
          summary.skippedNoSku += 1;
          continue;
        }

        const mapping = buildStoreMappingFromVariant(
          shopifyProduct,
          variant,
          storeContext,
        );
        const existingEntry = productsBySku.get(sku);

        if (existingEntry) {
          const currentData = existingEntry.data || {};
          const updatePayload = {
            sku,
            name: currentData.name || buildImportedProductName(shopifyProduct, variant),
            price: toSafeNumber(variant.price, toSafeNumber(currentData.price, 0)),
            [`shopifyMappings.${storeContext.storeId}`]: mapping,
            updatedAt: FieldValue.serverTimestamp(),
          };

          if (!currentData.shopifyInventoryItemId && mapping.inventoryItemId) {
            updatePayload.shopifyInventoryItemId = mapping.inventoryItemId;
          }
          if (!currentData.shopifyLocationId && mapping.locationId) {
            updatePayload.shopifyLocationId = mapping.locationId;
          }

          await existingEntry.ref.set(updatePayload, { merge: true });
          existingEntry.data = {
            ...currentData,
            ...updatePayload,
          };
          summary.mappedExisting += 1;
        } else {
          const newProduct = {
            sku,
            name: buildImportedProductName(shopifyProduct, variant),
            quantityOnHand: Math.max(0, toSafeNumber(variant.inventory_quantity, 0)),
            reorderPoint: 0,
            price: toSafeNumber(variant.price, 0),
            shopifyInventoryItemId: mapping.inventoryItemId || "",
            shopifyLocationId: mapping.locationId || "",
            shopifyMappings: {
              [storeContext.storeId]: mapping,
            },
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            source: "shopify_product_sync",
          };

          const newProductRef = productsRef.doc();
          await newProductRef.set(newProduct);
          productsBySku.set(sku, {
            id: newProductRef.id,
            ref: newProductRef,
            data: newProduct,
          });
          summary.createdProducts += 1;
        }
      }
    }

    sinceId = String(shopifyProducts[shopifyProducts.length - 1]?.id || "");
    if (shopifyProducts.length < 250 || !sinceId) {
      break;
    }

    await sleep(pageDelayMs);
  }

  return summary;
}

export const shopifyOAuthStart = onRequest(FUNCTION_OPTIONS, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Only GET is supported." });
    return;
  }

  try {
    const { apiKey, redirectUri, scopes } = getShopifyAppConfig();
    const shop = sanitizeShopDomain(req.query.shop);

    if (!shop || !shop.endsWith(".myshopify.com")) {
      res.status(400).json({ error: "A valid shop domain is required." });
      return;
    }

    const state = randomBytes(24).toString("hex");
    const postAuthRedirect =
      typeof req.query.postAuthRedirect === "string"
        ? req.query.postAuthRedirect
        : process.env.SHOPIFY_OAUTH_POST_AUTH_REDIRECT || "";

    await shopifyOAuthStatesRef.doc(state).set({
      shop,
      postAuthRedirect,
      createdAt: FieldValue.serverTimestamp(),
    });

    const authorizeUrl = new URL(`https://${shop}/admin/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", apiKey);
    authorizeUrl.searchParams.set("scope", scopes);
    authorizeUrl.searchParams.set("redirect_uri", redirectUri);
    authorizeUrl.searchParams.set("state", state);

    res.redirect(authorizeUrl.toString());
  } catch (error) {
    logger.error("Failed to start OAuth flow.", error);
    res.status(500).json({ error: error.message });
  }
});

export const shopifyOAuthCallback = onRequest(FUNCTION_OPTIONS, async (req, res) => {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Only GET is supported." });
    return;
  }

  try {
    const { apiKey, apiSecret } = getShopifyAppConfig();
    const query = req.query || {};
    const shop = sanitizeShopDomain(query.shop);
    const code = String(query.code || "");
    const state = String(query.state || "");

    if (!verifyOAuthCallback(query)) {
      res.status(401).json({ error: "OAuth HMAC validation failed." });
      return;
    }

    if (!shop || !code || !state) {
      res.status(400).json({ error: "Missing required OAuth callback fields." });
      return;
    }

    const stateDoc = await shopifyOAuthStatesRef.doc(state).get();
    if (!stateDoc.exists) {
      res.status(400).json({ error: "Invalid OAuth state." });
      return;
    }

    const stateData = stateDoc.data();
    if (stateData.shop !== shop) {
      res.status(400).json({ error: "OAuth state shop mismatch." });
      return;
    }

    const tokenResponse = await runWithShopifyRetry(
      () =>
        axios.post(`https://${shop}/admin/oauth/access_token`, {
          client_id: apiKey,
          client_secret: apiSecret,
          code,
        }),
      `OAuth token exchange for ${shop}`,
    );

    const accessToken = tokenResponse.data?.access_token;
    if (!accessToken) {
      throw new Error("OAuth token exchange did not return an access token.");
    }

    const storeId = toStoreId(shop);
    await shopifyStoresRef.doc(storeId).set(
      {
        shop,
        accessToken,
        scope: tokenResponse.data?.scope || "",
        status: "active",
        defaultLocationId: process.env.SHOPIFY_LOCATION_ID || null,
        installedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );

    let webhookRegistrationStatus = "ok";
    let webhookRegistrationError = "";
    let webhookRegistrationSummary = null;
    try {
      webhookRegistrationSummary = await ensurePubSubWebhooksForStore({
        storeId,
        shop,
        accessToken,
        defaultLocationId: process.env.SHOPIFY_LOCATION_ID || null,
      });
      await shopifyStoresRef.doc(storeId).set(
        {
          webhookRegistrationStatus: "ok",
          webhookRegistrationError: "",
          webhookRegistrationSummary,
          webhookRegistrationAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    } catch (registrationError) {
      webhookRegistrationStatus = "failed";
      webhookRegistrationError = registrationError.message;
      logger.error(
        `Webhook auto-registration failed for store ${shop} (${storeId}).`,
        registrationError,
      );
      await shopifyStoresRef.doc(storeId).set(
        {
          webhookRegistrationStatus: "failed",
          webhookRegistrationError,
          webhookRegistrationAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      );
    }

    await shopifyOAuthStatesRef.doc(state).delete();

    const redirectTarget = stateData.postAuthRedirect;
    if (redirectTarget) {
      const callbackUrl = new URL(redirectTarget);
      callbackUrl.searchParams.set("shopify", "connected");
      callbackUrl.searchParams.set("storeId", storeId);
      callbackUrl.searchParams.set("shop", shop);
      callbackUrl.searchParams.set("webhookRegistration", webhookRegistrationStatus);
      if (webhookRegistrationStatus === "failed") {
        callbackUrl.searchParams.set("webhookError", webhookRegistrationError);
      }
      res.redirect(callbackUrl.toString());
      return;
    }

    res.status(200).json({
      ok: true,
      message: "Shopify OAuth completed.",
      storeId,
      shop,
      webhookRegistrationStatus,
      webhookRegistrationSummary,
      webhookRegistrationError,
    });
  } catch (error) {
    logger.error("OAuth callback failed.", error);
    res.status(500).json({ error: error.message });
  }
});

export const shopifyOrderCreatedWebhook = onRequest(
  { ...FUNCTION_OPTIONS, cors: false },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Only POST is supported." });
      return;
    }

    if (!verifyShopifyWebhook(req)) {
      res.status(401).json({ error: "Webhook signature validation failed." });
      return;
    }

    try {
      const order = parseJsonBody(req);
      const storeContext = await getWebhookStoreContext(req);
      const result = await processOrderCreatedPayload(
        order,
        storeContext,
        "webhook_order_create",
      );

      res.status(200).json({
        ok: true,
        orderId: result.orderId,
        skipped: result.skipped,
      });
    } catch (error) {
      logger.error("Failed processing Shopify order create webhook.", error);
      res.status(500).json({ error: error.message });
    }
  },
);

export const shopifyOrderCancelledWebhook = onRequest(
  { ...FUNCTION_OPTIONS, cors: false },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Only POST is supported." });
      return;
    }

    if (!verifyShopifyWebhook(req)) {
      res.status(401).json({ error: "Webhook signature validation failed." });
      return;
    }

    try {
      const order = parseJsonBody(req);
      const storeContext = await getWebhookStoreContext(req);
      const result = await processOrderCancelledPayload(
        order,
        storeContext,
        "webhook_order_cancelled",
      );
      res.status(200).json({
        ok: true,
        orderId: result.orderId,
        skipped: result.skipped,
      });
    } catch (error) {
      logger.error("Failed processing Shopify order cancelled webhook.", error);
      res.status(500).json({ error: error.message });
    }
  },
);

export const shopifyRefundCreatedWebhook = onRequest(
  { ...FUNCTION_OPTIONS, cors: false },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Only POST is supported." });
      return;
    }

    if (!verifyShopifyWebhook(req)) {
      res.status(401).json({ error: "Webhook signature validation failed." });
      return;
    }

    try {
      const refundPayload = parseJsonBody(req);
      const storeContext = await getWebhookStoreContext(req);
      const result = await processRefundPayload(
        refundPayload,
        storeContext,
        "webhook_refund_create",
      );
      res.status(200).json({
        ok: true,
        orderId: result.orderId,
        refundId: result.refundId,
        skipped: result.skipped,
      });
    } catch (error) {
      logger.error("Failed processing Shopify refund webhook.", error);
      res.status(500).json({ error: error.message });
    }
  },
);

function getPubSubShopDomain(event, payload = {}) {
  const attributes = getPubSubAttributes(event);
  return sanitizeShopDomain(
    pickFirstDefined([
      attributes["x-shopify-shop-domain"],
      attributes["X-Shopify-Shop-Domain"],
      attributes["shopify_shop_domain"],
      payload.shop_domain,
      payload.shopDomain,
    ]),
  );
}

async function getPubSubStoreContext(event, payload = {}) {
  const shopDomain = getPubSubShopDomain(event, payload);
  return getStoreContextByShopDomain(shopDomain);
}

export const shopifyOrdersCreatePubSub = onMessagePublished(
  { topic: PUBSUB_TOPICS.ordersCreate, region: REGION },
  async (event) => {
    const payload = parsePubSubJson(event);
    if (!payload?.id) {
      logger.warn("shopifyOrdersCreatePubSub received payload without order id.");
      return;
    }

    const storeContext = await getPubSubStoreContext(event, payload);
    await processOrderCreatedPayload(payload, storeContext, "pubsub_order_create");
  },
);

export const shopifyOrdersCancelledPubSub = onMessagePublished(
  { topic: PUBSUB_TOPICS.ordersCancelled, region: REGION },
  async (event) => {
    const payload = parsePubSubJson(event);
    if (!payload?.id) {
      logger.warn("shopifyOrdersCancelledPubSub received payload without order id.");
      return;
    }

    const storeContext = await getPubSubStoreContext(event, payload);
    await processOrderCancelledPayload(payload, storeContext, "pubsub_order_cancelled");
  },
);

export const shopifyRefundsCreatePubSub = onMessagePublished(
  { topic: PUBSUB_TOPICS.refundsCreate, region: REGION },
  async (event) => {
    const payload = parsePubSubJson(event);
    if (!payload?.id || !payload?.order_id) {
      logger.warn("shopifyRefundsCreatePubSub payload missing refund or order id.");
      return;
    }

    const storeContext = await getPubSubStoreContext(event, payload);
    await processRefundPayload(payload, storeContext, "pubsub_refund_create");
  },
);

export const syncShopifyProducts = onRequest(FUNCTION_OPTIONS, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Only POST is supported." });
    return;
  }

  if (!isSyncRequestAuthorized(req)) {
    res.status(401).json({ error: "Invalid sync token." });
    return;
  }

  const storeId = typeof req.body?.storeId === "string" ? req.body.storeId : "";
  const shop = typeof req.body?.shop === "string" ? req.body.shop : "";
  const pageDelayMs = getBatchDelayMs(req.body?.pageDelayMs, 200);

  try {
    const stores = await getStoresForSync({ storeId, shop });
    if (stores.length === 0) {
      res.status(400).json({ error: "No active Shopify stores found." });
      return;
    }

    const summary = {
      storesProcessed: 0,
      pulledProducts: 0,
      variantsSeen: 0,
      mappedExisting: 0,
      createdProducts: 0,
      skippedNoSku: 0,
      failed: [],
      storeBreakdown: {},
    };

    for (const storeContext of stores) {
      try {
        const storeSummary = await syncShopifyProductsForStore(storeContext, {
          pageDelayMs,
        });
        summary.storesProcessed += 1;
        summary.pulledProducts += storeSummary.pulledProducts;
        summary.variantsSeen += storeSummary.variantsSeen;
        summary.mappedExisting += storeSummary.mappedExisting;
        summary.createdProducts += storeSummary.createdProducts;
        summary.skippedNoSku += storeSummary.skippedNoSku;
        summary.storeBreakdown[storeContext.storeId] = storeSummary;
      } catch (error) {
        summary.failed.push({
          storeId: storeContext.storeId,
          shop: storeContext.shop,
          error: error.message,
        });
      }
    }

    res.status(200).json({
      message: `Product sync complete. ${summary.createdProducts} created, ${summary.mappedExisting} mapped.`,
      ...summary,
    });
  } catch (error) {
    logger.error("Product sync failed.", error);
    res.status(500).json({ error: error.message });
  }
});

export const syncShopifyOrders = onRequest(FUNCTION_OPTIONS, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Only POST is supported." });
    return;
  }

  if (!isSyncRequestAuthorized(req)) {
    res.status(401).json({ error: "Invalid sync token." });
    return;
  }

  const createdAtMin =
    typeof req.body?.createdAtMin === "string" ? req.body.createdAtMin : undefined;
  const orderLimit = Math.min(toSafeNumber(req.body?.limit, 50), 250);
  const batchSize = getBatchSize(req.body?.batchSize, getSyncBatchSize());
  const batchDelayMs = getBatchDelayMs(req.body?.batchDelayMs, getSyncBatchDelayMs());
  const storeId = typeof req.body?.storeId === "string" ? req.body.storeId : "";
  const shop = typeof req.body?.shop === "string" ? req.body.shop : "";

  try {
    const stores = await getStoresForSync({ storeId, shop });
    if (stores.length === 0) {
      res.status(400).json({ error: "No active Shopify stores found." });
      return;
    }

    const summary = {
      storesProcessed: 0,
      pulled: 0,
      processed: 0,
      skipped: 0,
      failed: [],
      storeBreakdown: {},
    };

    for (const storeContext of stores) {
      const shopify = getShopifyClientForStore(storeContext);
      const ordersResponse = await runWithShopifyRetry(
        () =>
          shopify.get("/orders.json", {
            params: {
              status: "any",
              order: "created_at desc",
              limit: orderLimit,
              ...(createdAtMin ? { created_at_min: createdAtMin } : {}),
            },
          }),
        `order fetch for ${storeContext.shop}`,
      );

      const orders = Array.isArray(ordersResponse.data?.orders)
        ? ordersResponse.data.orders
        : [];
      const storeSummary = {
        pulled: orders.length,
        processed: 0,
        skipped: 0,
        failed: [],
      };

      const batches = chunkArray(orders, batchSize);
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        const batch = batches[batchIndex];

        for (const order of batch) {
          try {
            const result = await applyOrderToInventory(order, storeContext, "manual_sync");
            if (result.skipped) {
              storeSummary.skipped += 1;
            } else {
              storeSummary.processed += 1;
            }

            if (order.cancelled_at) {
              await restockCancelledOrder(order, storeContext, "manual_sync_cancelled");
            }

            if (Array.isArray(order.refunds)) {
              for (const refund of order.refunds) {
                await applyRefundToInventory(
                  { ...refund, order_id: order.id },
                  storeContext,
                  "manual_sync_refund",
                  order.line_items,
                );
              }
            }
          } catch (error) {
            storeSummary.failed.push({
              orderId: order.id || null,
              error: error.message,
            });
          }
        }

        if (batchIndex < batches.length - 1) {
          await sleep(batchDelayMs);
        }
      }

      summary.storesProcessed += 1;
      summary.pulled += storeSummary.pulled;
      summary.processed += storeSummary.processed;
      summary.skipped += storeSummary.skipped;
      summary.failed.push(...storeSummary.failed);
      summary.storeBreakdown[storeContext.storeId] = storeSummary;
      await sleep(getShopifyRequestDelayMs());
    }

    res.status(200).json({
      message: `Order sync complete. ${summary.processed} order(s) processed across ${summary.storesProcessed} store(s).`,
      ...summary,
    });
  } catch (error) {
    logger.error("Order sync failed.", error);
    res.status(500).json({ error: error.message });
  }
});

export const syncStockToShopify = onRequest(FUNCTION_OPTIONS, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Only POST is supported." });
    return;
  }

  if (!isSyncRequestAuthorized(req)) {
    res.status(401).json({ error: "Invalid sync token." });
    return;
  }

  const storeId = typeof req.body?.storeId === "string" ? req.body.storeId : "";
  const shop = typeof req.body?.shop === "string" ? req.body.shop : "";
  const batchSize = getBatchSize(req.body?.batchSize, getSyncBatchSize());
  const batchDelayMs = getBatchDelayMs(req.body?.batchDelayMs, getSyncBatchDelayMs());

  try {
    const stores = await getStoresForSync({ storeId, shop });
    if (stores.length === 0) {
      res.status(400).json({ error: "No active Shopify stores found." });
      return;
    }

    const productsSnapshot = await productsRef.get();
    const products = productsSnapshot.docs.map((docSnapshot) => ({
      id: docSnapshot.id,
      ...docSnapshot.data(),
    }));

    const summary = {
      storesProcessed: 0,
      considered: products.length * stores.length,
      updated: 0,
      skipped: 0,
      failed: [],
      storeBreakdown: {},
    };

    for (const storeContext of stores) {
      const shopify = getShopifyClientForStore(storeContext);
      const storeSummary = {
        considered: products.length,
        updated: 0,
        skipped: 0,
        failed: [],
      };

      const batches = chunkArray(products, batchSize);
      for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        const batch = batches[batchIndex];

        for (const product of batch) {
          const mapping = extractProductMapping(product, storeContext);
          if (!mapping) {
            storeSummary.skipped += 1;
            continue;
          }

          try {
            await runWithShopifyRetry(
              () =>
                shopify.post("/inventory_levels/set.json", {
                  inventory_item_id: mapping.inventoryItemId,
                  location_id: mapping.locationId,
                  available: toSafeNumber(product.quantityOnHand),
                }),
              `stock push for ${product.sku || product.id} (${storeContext.shop})`,
            );

            storeSummary.updated += 1;
            await sleep(getShopifyRequestDelayMs());
          } catch (error) {
            storeSummary.failed.push({
              productId: product.id,
              sku: product.sku || null,
              error: error.message,
            });
          }
        }

        if (batchIndex < batches.length - 1) {
          await sleep(batchDelayMs);
        }
      }

      summary.storesProcessed += 1;
      summary.updated += storeSummary.updated;
      summary.skipped += storeSummary.skipped;
      summary.failed.push(...storeSummary.failed);
      summary.storeBreakdown[storeContext.storeId] = storeSummary;
    }

    res.status(200).json({
      message: `Stock sync complete. ${summary.updated} SKU update(s) pushed across ${summary.storesProcessed} store(s).`,
      ...summary,
    });
  } catch (error) {
    logger.error("Stock sync failed.", error);
    res.status(500).json({ error: error.message });
  }
});
