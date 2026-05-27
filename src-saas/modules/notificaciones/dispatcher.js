/**
 * Dispatcher de notificaciones por tipo de canal.
 * Cada adapter implementa send(canal, payload) y puede ser un stub que
 * solo loguea, o uno real (SendGrid/Twilio/Mailgun/webhook).
 *
 * En produccion: setear las credenciales en canal.config.
 */
import { logger } from "../../shared/logging/logger.js";

/**
 * EMAIL via SMTP / SendGrid HTTP API.
 * canal.config: { provider: 'smtp'|'sendgrid', api_key?, from?, host?, port?, user?, pass? }
 */
const sendEmail = async (canal, { asunto, cuerpo, destinatarios }) => {
  const cfg = canal.config || {};
  const provider = String(cfg.provider || "log").toLowerCase();

  if (provider === "log") {
    // Default: solo loguea (util para dev)
    logger.info(
      { canal: canal.nombre, asunto, destinatarios },
      "[notif:EMAIL stub] mensaje no enviado realmente, solo log"
    );
    return { ok: true, stub: true };
  }

  if (provider === "sendgrid") {
    const apiKey = cfg.api_key || process.env.SENDGRID_API_KEY;
    if (!apiKey) throw new Error("SENDGRID_API_KEY no configurada");
    const from = cfg.from || process.env.NOTIF_EMAIL_FROM || "noreply@example.com";
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        personalizations: [
          {
            to: (destinatarios || []).map((email) => ({ email })),
            subject: asunto,
          },
        ],
        from: { email: from },
        content: [{ type: "text/plain", value: cuerpo || "" }],
      }),
    });
    if (!response.ok) {
      throw new Error(`SendGrid HTTP ${response.status}: ${await response.text()}`);
    }
    return { ok: true };
  }

  // SMTP via nodemailer requeriría dep extra. Stub por ahora.
  throw new Error(`Provider de email "${provider}" no implementado`);
};

/**
 * WhatsApp via Twilio.
 * canal.config: { account_sid, auth_token, from }
 */
const sendWhatsApp = async (canal, { cuerpo, destinatarios }) => {
  const cfg = canal.config || {};

  if (!cfg.account_sid || !cfg.auth_token || !cfg.from) {
    logger.info(
      { canal: canal.nombre, destinatarios },
      "[notif:WA stub] sin credenciales twilio, solo log"
    );
    return { ok: true, stub: true };
  }

  const auth = Buffer.from(`${cfg.account_sid}:${cfg.auth_token}`).toString("base64");

  for (const to of destinatarios || []) {
    const params = new URLSearchParams();
    params.append("From", `whatsapp:${cfg.from}`);
    params.append("To", `whatsapp:${to}`);
    params.append("Body", cuerpo || "");

    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${cfg.account_sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: params,
      }
    );
    if (!response.ok) {
      throw new Error(`Twilio HTTP ${response.status}: ${await response.text()}`);
    }
  }

  return { ok: true };
};

/**
 * Webhook generico: POST con el payload completo.
 * canal.config: { url, headers? }
 */
const sendWebhook = async (canal, payload) => {
  const cfg = canal.config || {};
  if (!cfg.url) {
    throw new Error("Webhook canal sin URL configurada");
  }

  const response = await fetch(cfg.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.headers || {}),
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Webhook HTTP ${response.status}`);
  }
  return { ok: true };
};

/**
 * Telegram via Bot API.
 * canal.config: { bot_token }
 * destinatarios: [chat_id, ...]
 */
const sendTelegram = async (canal, { cuerpo, destinatarios }) => {
  const cfg = canal.config || {};
  if (!cfg.bot_token) {
    logger.info(
      { canal: canal.nombre, destinatarios },
      "[notif:TG stub] sin bot_token, solo log"
    );
    return { ok: true, stub: true };
  }

  for (const chatId of destinatarios || []) {
    const response = await fetch(
      `https://api.telegram.org/bot${cfg.bot_token}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: cuerpo || "" }),
      }
    );
    if (!response.ok) {
      throw new Error(`Telegram HTTP ${response.status}`);
    }
  }
  return { ok: true };
};

/**
 * Despacha al canal correcto. Lanza error si falla.
 */
export const dispatch = async (canal, payload) => {
  const tipo = String(canal.tipo || "").toUpperCase();
  switch (tipo) {
    case "EMAIL":
      return sendEmail(canal, payload);
    case "WHATSAPP":
      return sendWhatsApp(canal, payload);
    case "WEBHOOK":
      return sendWebhook(canal, payload);
    case "TELEGRAM":
      return sendTelegram(canal, payload);
    default:
      throw new Error(`Canal de notificacion no soportado: ${tipo}`);
  }
};
