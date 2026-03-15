import { useEffect, useMemo, useState } from "react";
import "./App.css";
import {
  adjustStockTransaction,
  createProduct,
  subscribeToProducts,
} from "./services/inventoryService";

const INITIAL_FORM = {
  sku: "",
  name: "",
  quantityOnHand: 0,
  reorderPoint: 0,
  price: 0,
  shopifyInventoryItemId: "",
  shopifyLocationId: "",
};

const currencyFormatter = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
});

function App() {
  const [products, setProducts] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [formState, setFormState] = useState(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [syncingOrders, setSyncingOrders] = useState(false);
  const [syncingStock, setSyncingStock] = useState(false);

  const functionsBaseUrl = useMemo(() => {
    const rawValue = import.meta.env.VITE_FUNCTIONS_BASE_URL;
    if (!rawValue) {
      return "";
    }
    return rawValue.replace(/\/$/, "");
  }, []);

  const syncApiKey = import.meta.env.VITE_SYNC_API_KEY || "";

  useEffect(() => {
    const unsubscribe = subscribeToProducts(
      (nextProducts) => {
        setProducts(nextProducts);
        setLoadingProducts(false);
      },
      (subscriptionError) => {
        setError(subscriptionError.message);
        setLoadingProducts(false);
      },
    );

    return unsubscribe;
  }, []);

  async function runSync(route, setter) {
    if (!functionsBaseUrl) {
      setError("VITE_FUNCTIONS_BASE_URL is missing. Set it in .env.local.");
      return;
    }

    setter(true);
    setError("");
    setMessage("");

    try {
      const response = await fetch(`${functionsBaseUrl}/${route}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(syncApiKey ? { "x-sync-token": syncApiKey } : {}),
        },
        body: JSON.stringify({}),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || "Sync request failed.");
      }

      setMessage(
        payload.message || `Completed ${route} at ${new Date().toLocaleTimeString()}.`,
      );
    } catch (syncError) {
      setError(syncError.message);
    } finally {
      setter(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    setMessage("");

    try {
      await createProduct(formState);
      setFormState(INITIAL_FORM);
      setMessage("Product created.");
    } catch (createError) {
      setError(createError.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function adjustProduct(productId, delta) {
    setError("");
    setMessage("");

    try {
      await adjustStockTransaction(
        productId,
        delta,
        delta > 0 ? "manual_increment" : "manual_decrement",
      );
    } catch (adjustError) {
      setError(adjustError.message);
    }
  }

  function handleInputChange(event) {
    const { name, value, type } = event.target;
    setFormState((previous) => ({
      ...previous,
      [name]: type === "number" ? Number(value) : value,
    }));
  }

  return (
    <main className="app-shell">
      <header className="page-header">
        <h1>Inventory Control + Shopify Sync</h1>
        <p>
          Firestore is the product database and source of truth for stock on hand
          (SOH). Inventory movement updates are transactional.
        </p>
      </header>

      <section className="card">
        <h2>Add Product</h2>
        <form className="grid-form" onSubmit={handleSubmit}>
          <label>
            SKU
            <input
              required
              name="sku"
              value={formState.sku}
              onChange={handleInputChange}
            />
          </label>
          <label>
            Name
            <input
              required
              name="name"
              value={formState.name}
              onChange={handleInputChange}
            />
          </label>
          <label>
            Opening SOH
            <input
              required
              min={0}
              type="number"
              name="quantityOnHand"
              value={formState.quantityOnHand}
              onChange={handleInputChange}
            />
          </label>
          <label>
            Reorder Point
            <input
              required
              min={0}
              type="number"
              name="reorderPoint"
              value={formState.reorderPoint}
              onChange={handleInputChange}
            />
          </label>
          <label>
            Unit Price (AUD)
            <input
              required
              min={0}
              step="0.01"
              type="number"
              name="price"
              value={formState.price}
              onChange={handleInputChange}
            />
          </label>
          <label>
            Shopify Inventory Item ID
            <input
              name="shopifyInventoryItemId"
              value={formState.shopifyInventoryItemId}
              onChange={handleInputChange}
            />
          </label>
          <label>
            Shopify Location ID
            <input
              name="shopifyLocationId"
              value={formState.shopifyLocationId}
              onChange={handleInputChange}
            />
          </label>
          <button type="submit" disabled={submitting}>
            {submitting ? "Saving..." : "Create Product"}
          </button>
        </form>
      </section>

      <section className="card">
        <h2>Shopify Sync</h2>
        <p className="help-text">
          These buttons call your Firebase HTTP Functions endpoints.
        </p>
        <div className="button-row">
          <button
            type="button"
            onClick={() => runSync("syncShopifyOrders", setSyncingOrders)}
            disabled={syncingOrders}
          >
            {syncingOrders ? "Syncing Orders..." : "Sync Orders from Shopify"}
          </button>
          <button
            type="button"
            onClick={() => runSync("syncStockToShopify", setSyncingStock)}
            disabled={syncingStock}
          >
            {syncingStock ? "Pushing SOH..." : "Push SOH to Shopify"}
          </button>
        </div>
        {!functionsBaseUrl ? (
          <p className="warning">
            Set <code>VITE_FUNCTIONS_BASE_URL</code> in your local env to enable
            sync buttons.
          </p>
        ) : null}
      </section>

      <section className="card">
        <h2>Products</h2>
        {loadingProducts ? <p>Loading...</p> : null}
        {!loadingProducts && products.length === 0 ? (
          <p>No products yet.</p>
        ) : null}
        {products.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>Name</th>
                  <th>SOH</th>
                  <th>Reorder Point</th>
                  <th>Price</th>
                  <th>Adjust</th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.id}>
                    <td>{product.sku}</td>
                    <td>{product.name}</td>
                    <td
                      className={
                        Number(product.quantityOnHand) <= Number(product.reorderPoint)
                          ? "low-stock"
                          : ""
                      }
                    >
                      {product.quantityOnHand}
                    </td>
                    <td>{product.reorderPoint}</td>
                    <td>{currencyFormatter.format(Number(product.price || 0))}</td>
                    <td className="button-row">
                      <button
                        type="button"
                        onClick={() => adjustProduct(product.id, -1)}
                      >
                        -1
                      </button>
                      <button
                        type="button"
                        onClick={() => adjustProduct(product.id, 1)}
                      >
                        +1
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {error ? <p className="status error">{error}</p> : null}
      {message ? <p className="status success">{message}</p> : null}
    </main>
  );
}

export default App;
