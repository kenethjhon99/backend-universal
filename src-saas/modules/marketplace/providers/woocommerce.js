/**
 * Adapter WooCommerce REST API v3.
 * config: { store_url, consumer_key, consumer_secret }
 */
const auth = (config) => {
  if (!config?.consumer_key || !config?.consumer_secret) {
    throw new Error("WooCommerce: consumer_key/consumer_secret requeridos");
  }
  return (
    "Basic " +
    Buffer.from(`${config.consumer_key}:${config.consumer_secret}`).toString("base64")
  );
};

const base = (config) => {
  const url = String(config?.store_url || "").replace(/\/$/, "");
  if (!url) throw new Error("WooCommerce: store_url requerido");
  return `${url}/wp-json/wc/v3`;
};

export const updateStock = async (config, { external_id, available }) => {
  const r = await fetch(`${base(config)}/products/${external_id}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: auth(config),
    },
    body: JSON.stringify({
      manage_stock: true,
      stock_quantity: Math.max(0, Math.floor(Number(available || 0))),
      stock_status: Number(available || 0) > 0 ? "instock" : "outofstock",
    }),
  });
  if (!r.ok) throw new Error(`WooCommerce HTTP ${r.status}: ${await r.text()}`);
  return await r.json();
};

export const listProductosExternos = async (config, { per_page = 50, page = 1 } = {}) => {
  const r = await fetch(`${base(config)}/products?per_page=${per_page}&page=${page}`, {
    headers: { Authorization: auth(config) },
  });
  if (!r.ok) throw new Error(`WooCommerce list HTTP ${r.status}`);
  return await r.json();
};
