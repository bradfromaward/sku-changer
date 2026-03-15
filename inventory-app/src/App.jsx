import { useEffect, useMemo, useState } from "react";
import {
  adjustStockTransaction,
  createProduct,
  subscribeToProducts,
  subscribeToStores,
} from "./services/inventoryService";

const currencyFormatter = new Intl.NumberFormat("en-AU", {
  style: "currency",
  currency: "AUD",
});

const ALL_STORES = "__all__";

const INITIAL_FORM = {
  sku: "",
  name: "",
  quantityOnHand: 0,
  reorderPoint: 0,
  price: 0,
  shopifyInventoryItemId: "",
  shopifyLocationId: "",
};

function App() {
  const [products, setProducts] = useState([]);
  const [stores, setStores] = useState([]);
  const [selectedStoreId, setSelectedStoreId] = useState(ALL_STORES);
  const [shopDomain, setShopDomain] = useState("");
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [loadingStores, setLoadingStores] = useState(true);
  const [formState, setFormState] = useState(INITIAL_FORM);
  const [submitting, setSubmitting] = useState(false);
  const [syncingProducts, setSyncingProducts] = useState(false);
  const [syncingOrders, setSyncingOrders] = useState(false);
  const [syncingStock, setSyncingStock] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const localFunctionsBaseUrl = useMemo(() => {
    const rawValue = import.meta.env.VITE_FUNCTIONS_BASE_URL;
    return rawValue ? rawValue.replace(/\/$/, "") : "";
  }, []);

  const oauthFunctionsBaseUrl = useMemo(() => {
    const rawValue =
      import.meta.env.VITE_OAUTH_FUNCTIONS_BASE_URL ||
      import.meta.env.VITE_FUNCTIONS_BASE_URL;
    return rawValue ? rawValue.replace(/\/$/, "") : "";
  }, []);

  const syncApiKey = import.meta.env.VITE_SYNC_API_KEY || "";

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("shopify") === "connected") {
      const connectedStoreId = params.get("storeId");
      const connectedShop = params.get("shop");
      const webhookRegistration = params.get("webhookRegistration");
      const webhookError = params.get("webhookError");
      setMessage(
        connectedStoreId
          ? `Connected Shopify store ${connectedShop || connectedStoreId}.`
          : "Shopify store connected.",
      );
      if (webhookRegistration === "failed") {
        setError(
          webhookError
            ? `Store connected, but webhook auto-registration failed: ${webhookError}`
            : "Store connected, but webhook auto-registration failed.",
        );
      } else if (webhookRegistration === "ok") {
        setMessage((previous) => `${previous} Pub/Sub webhooks registered.`);
      }
      if (connectedStoreId) {
        setSelectedStoreId(connectedStoreId);
      }
      params.delete("shopify");
      params.delete("storeId");
      params.delete("shop");
      params.delete("webhookRegistration");
      params.delete("webhookError");
      const next = params.toString();
      window.history.replaceState({}, "", `${window.location.pathname}${next ? `?${next}` : ""}`);
    }
  }, []);

  useEffect(() => {
    const unsubscribeProducts = subscribeToProducts(
      (nextProducts) => {
        setProducts(nextProducts);
        setLoadingProducts(false);
      },
      (subscriptionError) => {
        setError(subscriptionError.message);
        setLoadingProducts(false);
      },
    );

    const unsubscribeStores = subscribeToStores(
      (nextStores) => {
        setStores(nextStores);
        setLoadingStores(false);
      },
      (subscriptionError) => {
        setError(subscriptionError.message);
        setLoadingStores(false);
      },
    );

    return () => {
      unsubscribeProducts();
      unsubscribeStores();
    };
  }, []);

  async function runSync(route, setter) {
    if (!localFunctionsBaseUrl) {
      setError("VITE_FUNCTIONS_BASE_URL is missing. Set it in .env.local.");
      return;
    }

    setter(true);
    setError("");
    setMessage("");

    const body = {
      ...(selectedStoreId !== ALL_STORES ? { storeId: selectedStoreId } : {}),
    };
    const endpoint = `${localFunctionsBaseUrl}/${route}`;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(syncApiKey ? { "x-sync-token": syncApiKey } : {}),
        },
        body: JSON.stringify(body),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const serverError =
          payload?.error ||
          payload?.message ||
          (Object.keys(payload || {}).length > 0 ? JSON.stringify(payload) : "");
        throw new Error(
          [
            `Request failed for "${route}".`,
            `Endpoint: ${endpoint}`,
            `HTTP: ${response.status} ${response.statusText}`,
            serverError ? `Server error: ${serverError}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      }

      setMessage(payload.message || `Completed ${route}.`);
    } catch (syncError) {
      const message = String(syncError?.message || "");
      const isNetworkError =
        message.toLowerCase().includes("failed to fetch") ||
        message.toLowerCase().includes("networkerror");

      if (isNetworkError) {
        setError(
          [
            `Cannot reach local function "${route}".`,
            `Endpoint: ${endpoint}`,
            `Browser message: ${message || "Failed to fetch"}`,
            `Browser online: ${navigator.onLine ? "yes" : "no"}`,
            `App origin: ${window.location.origin}`,
            "",
            "Checks:",
            "1) Start emulators: firebase emulators:start --only functions,firestore",
            `2) Confirm VITE_FUNCTIONS_BASE_URL matches emulator URL and project id`,
            "3) Open the endpoint directly in browser/Postman to verify it is reachable",
            "4) If app is https:// and functions URL is http://, browser may block mixed content",
          ].join("\n"),
        );
      } else {
        setError(message || "Sync request failed.");
      }
    } finally {
      setter(false);
    }
  }

  async function connectStore() {
    if (!oauthFunctionsBaseUrl) {
      setError(
        "VITE_OAUTH_FUNCTIONS_BASE_URL is missing. Set it to your deployed functions URL.",
      );
      return;
    }

    const normalizedShop = shopDomain.trim().toLowerCase();
    if (!normalizedShop.endsWith(".myshopify.com")) {
      setError("Enter a valid Shopify domain ending in .myshopify.com.");
      return;
    }

    const oauthUrl = new URL(`${oauthFunctionsBaseUrl}/shopifyOAuthStart`);
    oauthUrl.searchParams.set("shop", normalizedShop);
    oauthUrl.searchParams.set("postAuthRedirect", window.location.origin);
    window.location.assign(oauthUrl.toString());
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    setMessage("");

    try {
      await createProduct({
        ...formState,
        selectedStoreId: selectedStoreId !== ALL_STORES ? selectedStoreId : "",
      });
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
    <main className="mx-auto min-h-screen w-full max-w-7xl bg-slate-100 p-6 text-slate-900">
      <header className="mb-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h1 className="text-2xl font-semibold">Inventory + Shopify Multi-Store Sync</h1>
        <p className="mt-2 text-sm text-slate-600">
          Firestore is your product database and stock source of truth. All inventory
          movement is transaction-safe.
        </p>
      </header>

      <section className="mb-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="flex min-w-64 flex-1 flex-col">
            <label className="mb-1 text-sm font-medium text-slate-700">
              Shopify shop domain
            </label>
            <input
              type="text"
              value={shopDomain}
              onChange={(event) => setShopDomain(event.target.value)}
              placeholder="your-store.myshopify.com"
              className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            />
          </div>
          <button
            type="button"
            onClick={connectStore}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
          >
            Connect store via OAuth
          </button>
        </div>

        <div className="rounded-md bg-slate-50 p-3 text-sm text-slate-700">
          <p className="mb-2 text-xs text-slate-500">
            OAuth can use a deployed URL via{" "}
            <code className="rounded bg-slate-200 px-1">
              VITE_OAUTH_FUNCTIONS_BASE_URL
            </code>{" "}
            while the sync actions use local{" "}
            <code className="rounded bg-slate-200 px-1">VITE_FUNCTIONS_BASE_URL</code>.
          </p>
          <p className="font-medium">Connected stores</p>
          {loadingStores ? <p className="mt-1">Loading stores...</p> : null}
          {!loadingStores && stores.length === 0 ? (
            <p className="mt-1 text-slate-500">No stores connected yet.</p>
          ) : null}
          {stores.length > 0 ? (
            <ul className="mt-2 list-inside list-disc">
              {stores.map((store) => (
                <li key={store.id}>
                  {store.shop} ({store.id})
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        {!oauthFunctionsBaseUrl ? (
          <p className="mt-2 text-sm text-amber-700">
            Set{" "}
            <code className="rounded bg-amber-100 px-1">
              VITE_OAUTH_FUNCTIONS_BASE_URL
            </code>{" "}
            to your deployed functions URL for OAuth.
          </p>
        ) : null}
      </section>

      <section className="mb-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div className="flex min-w-64 flex-col">
            <label className="mb-1 text-sm font-medium text-slate-700">Sync scope</label>
            <select
              value={selectedStoreId}
              onChange={(event) => setSelectedStoreId(event.target.value)}
              className="rounded-md border border-slate-300 px-3 py-2 text-sm outline-none focus:border-indigo-500"
            >
              <option value={ALL_STORES}>All stores</option>
              {stores.map((store) => (
                <option key={store.id} value={store.id}>
                  {store.shop}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            disabled={syncingProducts}
            onClick={() => runSync("syncShopifyProducts", setSyncingProducts)}
            className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
          >
            {syncingProducts ? "Pulling products..." : "Pull Shopify products"}
          </button>
          <button
            type="button"
            disabled={syncingOrders}
            onClick={() => runSync("syncShopifyOrders", setSyncingOrders)}
            className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
          >
            {syncingOrders ? "Syncing orders..." : "Sync orders"}
          </button>
          <button
            type="button"
            disabled={syncingStock}
            onClick={() => runSync("syncStockToShopify", setSyncingStock)}
            className="rounded-md bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-60"
          >
            {syncingStock ? "Pushing SOH..." : "Push SOH"}
          </button>
        </div>
        <p className="mb-2 text-xs text-slate-500">
          Pull Shopify products imports variants by SKU and maps Shopify IDs into each
          product record for the selected store.
        </p>

        {!localFunctionsBaseUrl ? (
          <p className="text-sm text-amber-700">
            Set <code className="rounded bg-amber-100 px-1">VITE_FUNCTIONS_BASE_URL</code>{" "}
            in <code className="rounded bg-amber-100 px-1">.env.local</code>.
          </p>
        ) : null}
      </section>

      <section className="mb-5 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-lg font-semibold">Add product</h2>
        <form
          className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
          onSubmit={handleSubmit}
        >
          <label className="flex flex-col text-sm text-slate-700">
            SKU
            <input
              required
              name="sku"
              value={formState.sku}
              onChange={handleInputChange}
              className="mt-1 rounded-md border border-slate-300 px-3 py-2 outline-none focus:border-indigo-500"
            />
          </label>

          <label className="flex flex-col text-sm text-slate-700">
            Name
            <input
              required
              name="name"
              value={formState.name}
              onChange={handleInputChange}
              className="mt-1 rounded-md border border-slate-300 px-3 py-2 outline-none focus:border-indigo-500"
            />
          </label>

          <label className="flex flex-col text-sm text-slate-700">
            Opening SOH
            <input
              required
              min={0}
              type="number"
              name="quantityOnHand"
              value={formState.quantityOnHand}
              onChange={handleInputChange}
              className="mt-1 rounded-md border border-slate-300 px-3 py-2 outline-none focus:border-indigo-500"
            />
          </label>

          <label className="flex flex-col text-sm text-slate-700">
            Reorder point
            <input
              required
              min={0}
              type="number"
              name="reorderPoint"
              value={formState.reorderPoint}
              onChange={handleInputChange}
              className="mt-1 rounded-md border border-slate-300 px-3 py-2 outline-none focus:border-indigo-500"
            />
          </label>

          <label className="flex flex-col text-sm text-slate-700">
            Unit price (AUD)
            <input
              required
              min={0}
              step="0.01"
              type="number"
              name="price"
              value={formState.price}
              onChange={handleInputChange}
              className="mt-1 rounded-md border border-slate-300 px-3 py-2 outline-none focus:border-indigo-500"
            />
          </label>

          <label className="flex flex-col text-sm text-slate-700">
            Shopify inventory item ID
            <input
              name="shopifyInventoryItemId"
              value={formState.shopifyInventoryItemId}
              onChange={handleInputChange}
              className="mt-1 rounded-md border border-slate-300 px-3 py-2 outline-none focus:border-indigo-500"
            />
          </label>

          <label className="flex flex-col text-sm text-slate-700">
            Shopify location ID
            <input
              name="shopifyLocationId"
              value={formState.shopifyLocationId}
              onChange={handleInputChange}
              className="mt-1 rounded-md border border-slate-300 px-3 py-2 outline-none focus:border-indigo-500"
            />
          </label>

          <div className="flex items-end">
            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60"
            >
              {submitting ? "Saving..." : "Create product"}
            </button>
          </div>
        </form>
        <p className="mt-3 text-xs text-slate-500">
          If you selected a specific store above, product mapping is saved under that store.
        </p>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="mb-3 text-lg font-semibold">Products</h2>
        {loadingProducts ? <p className="text-sm text-slate-600">Loading...</p> : null}
        {!loadingProducts && products.length === 0 ? (
          <p className="text-sm text-slate-500">No products yet.</p>
        ) : null}
        {products.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-slate-50">
                  <th className="border-b border-slate-200 px-3 py-2 text-left">SKU</th>
                  <th className="border-b border-slate-200 px-3 py-2 text-left">Name</th>
                  <th className="border-b border-slate-200 px-3 py-2 text-left">SOH</th>
                  <th className="border-b border-slate-200 px-3 py-2 text-left">
                    Reorder point
                  </th>
                  <th className="border-b border-slate-200 px-3 py-2 text-left">Price</th>
                  <th className="border-b border-slate-200 px-3 py-2 text-left">Adjust</th>
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.id}>
                    <td className="border-b border-slate-200 px-3 py-2">{product.sku}</td>
                    <td className="border-b border-slate-200 px-3 py-2">{product.name}</td>
                    <td
                      className={`border-b border-slate-200 px-3 py-2 ${
                        Number(product.quantityOnHand) <= Number(product.reorderPoint)
                          ? "font-semibold text-red-600"
                          : ""
                      }`}
                    >
                      {product.quantityOnHand}
                    </td>
                    <td className="border-b border-slate-200 px-3 py-2">
                      {product.reorderPoint}
                    </td>
                    <td className="border-b border-slate-200 px-3 py-2">
                      {currencyFormatter.format(Number(product.price || 0))}
                    </td>
                    <td className="border-b border-slate-200 px-3 py-2">
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => adjustProduct(product.id, -1)}
                          className="rounded bg-slate-200 px-2 py-1 text-xs text-slate-900 hover:bg-slate-300"
                        >
                          -1
                        </button>
                        <button
                          type="button"
                          onClick={() => adjustProduct(product.id, 1)}
                          className="rounded bg-slate-200 px-2 py-1 text-xs text-slate-900 hover:bg-slate-300"
                        >
                          +1
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      {error ? (
        <p className="mt-4 whitespace-pre-line break-words rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
          {message}
        </p>
      ) : null}
    </main>
  );
}

export default App;
