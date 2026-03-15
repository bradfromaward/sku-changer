import {
  addDoc,
  collection,
  doc,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "../firebase/client";

const productsCollection = collection(db, "products");
const inventoryMovementsCollection = collection(db, "inventoryMovements");

export function subscribeToProducts(onData, onError) {
  const productsQuery = query(productsCollection, orderBy("name"));
  return onSnapshot(
    productsQuery,
    (snapshot) => {
      const products = snapshot.docs.map((productDoc) => ({
        id: productDoc.id,
        ...productDoc.data(),
      }));
      onData(products);
    },
    onError,
  );
}

export async function createProduct(formState) {
  const sku = String(formState.sku || "").trim().toUpperCase();
  const name = String(formState.name || "").trim();
  const quantityOnHand = Number(formState.quantityOnHand || 0);
  const reorderPoint = Number(formState.reorderPoint || 0);
  const price = Number(formState.price || 0);

  if (!sku || !name) {
    throw new Error("SKU and product name are required.");
  }

  if (quantityOnHand < 0 || reorderPoint < 0 || price < 0) {
    throw new Error("Quantity, reorder point, and price must be non-negative.");
  }

  return addDoc(productsCollection, {
    sku,
    name,
    quantityOnHand,
    reorderPoint,
    price,
    shopifyInventoryItemId: String(formState.shopifyInventoryItemId || "").trim(),
    shopifyLocationId: String(formState.shopifyLocationId || "").trim(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function adjustStockTransaction(productId, delta, reason) {
  const parsedDelta = Number(delta);
  if (!parsedDelta) {
    throw new Error("Stock adjustment delta must be non-zero.");
  }

  const productRef = doc(db, "products", productId);
  await runTransaction(db, async (transaction) => {
    const productSnapshot = await transaction.get(productRef);
    if (!productSnapshot.exists()) {
      throw new Error("Product not found.");
    }

    const product = productSnapshot.data();
    const currentStock = Number(product.quantityOnHand || 0);
    const nextStock = currentStock + parsedDelta;

    if (nextStock < 0) {
      throw new Error(`Insufficient stock for SKU ${product.sku}.`);
    }

    transaction.update(productRef, {
      quantityOnHand: nextStock,
      updatedAt: serverTimestamp(),
    });

    const movementRef = doc(inventoryMovementsCollection);
    transaction.set(movementRef, {
      productId,
      sku: product.sku,
      delta: parsedDelta,
      reason,
      createdAt: serverTimestamp(),
    });
  });
}
