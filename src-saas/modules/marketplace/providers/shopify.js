/**
 * Adapter Shopify Admin API.
 * config: { store_domain (xxx.myshopify.com), access_token, api_version (2024-10) }
 */
const buildBase = (config) => {
  const domain = String(config?.store_domain || "").replace(/\/$/, "");
  const ver = config?.api_version || "2024-10";
  if (!domain) throw new Error("Shopify: store_domain requerido");
  if (!config?.access_token) throw new Error("Shopify: access_token requerido");
  return { baseUrl: `https://${domain}/admin/api/${ver}`, token: config.access_token };
};

const headers = (token) => ({
  "Content-Type": "application/json",
  "X-Shopify-Access-Token": token,
});

export const updateStock = async (config, { external_variant_id, available }) => {
  const { baseUrl, token } = buildBase(config);

  // 1. Obtener inventory_item_id desde la variante
  const v = await fetch(`${baseUrl}/variants/${external_variant_id}.json`, {
    headers: headers(token),
  });
  if (!v.ok) throw new Error(`Shopify variante HTTP ${v.status}`);
  const { variant } = await v.json();
  const inventoryItemId = variant?.inventory_item_id;

  // 2. Obtener location_id (default = primary). En real, esto se cachea o se pasa por config.
  const locResp = await fetch(`${baseUrl}/locations.json`, { headers: headers(token) });
  if (!locResp.ok) throw new Error(`Shopify locations HTTP ${locResp.status}`);
  const { locations } = await locResp.json();
  const locationId = locations?.[0]?.id;

  // 3. Set inventory level
  const setResp = await fetch(`${baseUrl}/inventory_levels/set.json`, {
    method: "POST",
    headers: headers(token),
    body: JSON.stringify({
      location_id: locationId,
      inventory_item_id: inventoryItemId,
      available: Math.max(0, Math.floor(Number(available || 0))),
    }),
  });
  if (!setResp.ok) {
    throw new Error(`Shopify set inventory HTTP ${setResp.status}: ${await setResp.text()}`);
  }
  return await setResp.json();
};

export const listProductosExternos = async (config, { limit = 50, since_id = null } = {}) => {
  const { baseUrl, token } = buildBase(config);
  const params = new URLSearchParams({ limit: String(limit) });
  if (since_id) params.set("since_id", String(since_id));
  const r = await fetch(`${baseUrl}/products.json?${params}`, { headers: headers(token) });
  if (!r.ok) throw new Error(`Shopify list HTTP ${r.status}`);
  return await r.json();
};
