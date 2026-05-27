/**
 * Provider STUB para desarrollo / pruebas. Simula una FE exitosa sin llamar
 * a ningun servicio externo. Genera un UUID falso.
 */
import crypto from "node:crypto";

export const certifyDocument = async (_canal, payload) => {
  await new Promise((r) => setTimeout(r, 50));
  return {
    ok: true,
    uuid: crypto.randomUUID(),
    serie: "STUB",
    numero: String(Date.now()).slice(-8),
    fecha_certificacion: new Date().toISOString(),
    xml: `<DTE-stub>${JSON.stringify(payload).slice(0, 200)}</DTE-stub>`,
    url_pdf: null,
    raw: { provider: "stub", message: "stub provider used; no fiscal effect" },
  };
};

export const cancelDocument = async (_canal, _payload) => {
  return { ok: true, message: "stub cancellation" };
};
