import axios from "axios";
import { createHmac, timingSafeEqual } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions/v2";

initializeApp();

const db = getFirestore();
const productsRef = db.collection("products");
const ordersRef = db.collection("orders");
const inventoryMovementsRef = db.collection("inventoryMovements");

const FUNCTION_OPTIONS = {
  region: "us-central1",
  cors: true,
};

function shopifyApiVersion() {
  return process.env.SHOPIFY_API_VERSION || "2025-10";
}

function validateShopifyConfig() {
  if (!process.env.SHOPIFY_SHOP) {
    throw new Error("Missing SHOPIFY_SHOP environment variable.");
  }
  if (!process.env.SHOPIFY_ADMIN_ACCESS_TOKEN) {
    throw new Error("Missing SHOPIFY_ADMIN_ACCESS_TOKEN environment variable.");
  }
}

function getShopifyClient() {
  validateShopifyConfig();

  return axios.create({
    baseURL: `https://${process.env.SHOPIFY_SHOP}/admin/api/${shopifyApiVersion()}`,
    headers: {
      "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_ACCESS_TOKEN,
      "Content-Type": "application/json",
    },
    timeout: 15000,
  });
}

function toSafeNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function verifyShopifyWebhook(req) {
  const webhookSecret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!webhookSecret) {
    logger.error("SHOPIFY_WEBHOOK_SECRET is not configured.");
    return false;
  }

  const headerValue = req.get("x-shopify-hmac-sha256");
  if (!headerValue || !req.rawBody) {
    return false;
  }

  const digest = createHmac("sha256", webhookSecret)
    .update(req.rawBody)
    .digest("base64");

  const digestBuffer = Buffer.from(digest, "utf8");
  const headerBuffer = Buffer.from(headerValue, "utf8");

  if (digestBuffer.length !== headerBuffer.length) {
    return false;
  }

  return timingSafeEqual(digestBuffer, headerBuffer);
}

function isSyncRequestAuthorized(req) {
  const requiredToken = process.env.SYNC_API_KEY;
  if (!requiredToken) {
    return true;
  }

  return req.get("x-sync-token") === requiredToken;
}

async function applyOrderToInventory(order, source) {
  if (!order?.id) {
    throw new Error("Order is missing an id.");
  }

  return db.runTransaction(async (transaction) => {
    const orderId = String(order.id);
    const orderDocRef = ordersRef.doc(orderId);
    const orderDocSnapshot = await transaction.get(orderDocRef);

    if (orderDocSnapshot.exists && orderDocSnapshot.data().inventoryApplied) {
      return {
        orderId,
        skipped: true,
        reason: "already_applied",
      };
    }

    const lineItems = sanitizeOrderLineItems(order.line_items);
    const unresolvedSkus = [];
    let movedItems = 0;

    for (const lineItem of lineItems) {
      if (!lineItem.sku || lineItem.quantity <= 0) {
        continue;
      }

      const productQuery = productsRef.where("sku", "==", lineItem.sku).limit(1);
      const matchingProducts = await transaction.get(productQuery);

      if (matchingProducts.empty) {
        unresolvedSkus.push({
          sku: lineItem.sku,
          quantity: lineItem.quantity,
          reason: "sku_not_found",
        });
        continue;
      }

      const productDoc = matchingProducts.docs[0];
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
        orderId,
        createdAt: FieldValue.serverTimestamp(),
      });

      movedItems += 1;
    }

    const existingOrder = orderDocSnapshot.exists ? orderDocSnapshot.data() : null;
    transaction.set(
      orderDocRef,
      {
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
      const order =
        typeof req.body === "object"
          ? req.body
          : JSON.parse(req.rawBody.toString("utf8"));

      const result = await applyOrderToInventory(order, "webhook");
      res.status(200).json({
        ok: true,
        orderId: result.orderId,
        skipped: result.skipped,
      });
    } catch (error) {
      logger.error("Failed processing Shopify webhook order.", error);
      res.status(500).json({ error: error.message });
    }
  },
);

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

  try {
    const shopify = getShopifyClient();
    const response = await shopify.get("/orders.json", {
      params: {
        status: "any",
        order: "created_at desc",
        limit: orderLimit,
        ...(createdAtMin ? { created_at_min: createdAtMin } : {}),
      },
    });

    const orders = Array.isArray(response.data?.orders) ? response.data.orders : [];
    const summary = {
      pulled: orders.length,
      processed: 0,
      skipped: 0,
      failed: [],
    };

    for (const order of orders) {
      try {
        const result = await applyOrderToInventory(order, "manual_sync");
        if (result.skipped) {
          summary.skipped += 1;
        } else {
          summary.processed += 1;
        }
      } catch (error) {
        summary.failed.push({
          orderId: order.id || null,
          error: error.message,
        });
      }
    }

    res.status(200).json({
      message: `Order sync complete. ${summary.processed} processed.`,
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

  try {
    const shopify = getShopifyClient();
    const productsSnapshot = await productsRef.get();
    const defaultLocationId = process.env.SHOPIFY_LOCATION_ID;

    const summary = {
      considered: productsSnapshot.size,
      updated: 0,
      skipped: 0,
      failed: [],
    };

    for (const productDoc of productsSnapshot.docs) {
      const product = productDoc.data();
      const inventoryItemId = toSafeNumber(product.shopifyInventoryItemId, NaN);
      const locationId = toSafeNumber(
        product.shopifyLocationId || defaultLocationId,
        NaN,
      );

      if (!Number.isFinite(inventoryItemId) || !Number.isFinite(locationId)) {
        summary.skipped += 1;
        continue;
      }

      try {
        await shopify.post("/inventory_levels/set.json", {
          inventory_item_id: inventoryItemId,
          location_id: locationId,
          available: toSafeNumber(product.quantityOnHand),
        });
        summary.updated += 1;
      } catch (error) {
        summary.failed.push({
          productId: productDoc.id,
          sku: product.sku || null,
          error: error.message,
        });
      }
    }

    res.status(200).json({
      message: `Stock sync complete. ${summary.updated} SKU(s) updated.`,
      ...summary,
    });
  } catch (error) {
    logger.error("Stock sync failed.", error);
    res.status(500).json({ error: error.message });
  }
});
