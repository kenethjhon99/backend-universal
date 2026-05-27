/**
 * Adapter para FEL Guatemala (esqueleto).
 *
 * En produccion necesitas:
 *   - Convenio firmado con un certificador (Infile, Cofidi, etc.)
 *   - Endpoint y credenciales del certificador
 *   - Generacion del XML DTE conforme al esquema de SAT
 *   - Firma electronica del documento
 *
 * Este archivo es la interfaz; la lógica real se llena cuando se contrata
 * el certificador. Mientras tanto, lanza error si fe_activa=true sin config.
 */
export const certifyDocument = async (config, payload) => {
  if (!config?.api_url || !config?.api_token) {
    throw new Error(
      "FEL_GT no configurado. Setea fe_config.api_url y fe_config.api_token en empresas."
    );
  }

  // Construir XML DTE (placeholder)
  const xmlDte = buildDte(payload, config);

  // POST al certificador
  const response = await fetch(`${config.api_url}/certificar`, {
    method: "POST",
    headers: {
      "Content-Type": "application/xml",
      Authorization: `Bearer ${config.api_token}`,
    },
    body: xmlDte,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`FEL_GT HTTP ${response.status}: ${text.slice(0, 500)}`);
  }

  const json = await response.json().catch(() => ({}));

  return {
    ok: true,
    uuid: json.uuid || json.authorization,
    serie: json.serie,
    numero: json.numero,
    fecha_certificacion: json.fecha_certificacion || new Date().toISOString(),
    xml: json.xml_signed || xmlDte,
    url_pdf: json.url_pdf || null,
    raw: json,
  };
};

export const cancelDocument = async (config, payload) => {
  if (!config?.api_url || !config?.api_token) {
    throw new Error("FEL_GT no configurado");
  }
  const response = await fetch(`${config.api_url}/anular`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.api_token}`,
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`FEL_GT cancel HTTP ${response.status}`);
  }
  return await response.json().catch(() => ({}));
};

const buildDte = (payload, config) => {
  // Placeholder: en produccion, generar XML conforme a la NIT del SAT GT
  // con todos los campos requeridos (Emisor, Receptor, Items, Impuestos).
  const v = payload.venta;
  return `<?xml version="1.0" encoding="UTF-8"?>
<dte:GTDocumento Version="0.1">
  <dte:SAT ClaseDocumento="dte">
    <dte:DTE ID="DatosCertificados">
      <dte:DatosEmision ID="DatosEmision">
        <dte:DatosGenerales CodigoMoneda="${v.moneda || "GTQ"}" FechaHoraEmision="${v.fecha_venta}" Tipo="${v.tipo_comprobante || "FACT"}" />
        <dte:Emisor NITEmisor="${config.nit_emisor || ""}" NombreEmisor="${config.nombre_emisor || ""}" CodigoEstablecimiento="${config.codigo_establecimiento || "1"}" />
        <dte:Receptor NombreReceptor="${escapeXml(payload.cliente?.nombre || "Consumidor Final")}" />
        <dte:Items>${(payload.detalles || [])
          .map(
            (d, i) => `
          <dte:Item NumeroLinea="${i + 1}">
            <dte:Cantidad>${d.cantidad}</dte:Cantidad>
            <dte:Descripcion>${escapeXml(d.producto_nombre || "")}</dte:Descripcion>
            <dte:PrecioUnitario>${d.precio_unitario}</dte:PrecioUnitario>
            <dte:Total>${d.subtotal}</dte:Total>
          </dte:Item>`
          )
          .join("")}
        </dte:Items>
        <dte:Totales><dte:GranTotal>${v.total}</dte:GranTotal></dte:Totales>
      </dte:DatosEmision>
    </dte:DTE>
  </dte:SAT>
</dte:GTDocumento>`;
};

const escapeXml = (s) =>
  String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
