/**
 * Parser CSV minimalista sin dependencias.
 * Soporta:
 *   - Comillas dobles (RFC 4180)
 *   - Escape "" -> "
 *   - Separadores , o ; (auto-detectado)
 *   - LF o CRLF
 *
 * Devuelve { headers, rows } con rows como Array<Record<string, string>>.
 */
export const parseCsv = (text) => {
  const content = String(text || "").replace(/^﻿/, ""); // BOM
  if (!content.trim()) return { headers: [], rows: [] };

  // Detectar separador: contar , y ; en la primera linea no quoted
  const firstLine = content.split(/\r?\n/)[0] || "";
  const commas = (firstLine.match(/,/g) || []).length;
  const semis = (firstLine.match(/;/g) || []).length;
  const sep = semis > commas ? ";" : ",";

  const records = [];
  let currentField = "";
  let currentRow = [];
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    const next = content[i + 1];

    if (inQuotes) {
      if (ch === '"' && next === '"') {
        currentField += '"';
        i += 1;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        currentField += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === sep) {
        currentRow.push(currentField);
        currentField = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && next === "\n") i += 1;
        currentRow.push(currentField);
        records.push(currentRow);
        currentRow = [];
        currentField = "";
      } else {
        currentField += ch;
      }
    }
  }

  // Ultima fila si no termino con newline
  if (currentField.length > 0 || currentRow.length > 0) {
    currentRow.push(currentField);
    records.push(currentRow);
  }

  // Filtrar filas completamente vacias
  const cleaned = records.filter(
    (row) => row.length > 0 && row.some((c) => String(c).trim() !== "")
  );

  if (cleaned.length === 0) return { headers: [], rows: [] };

  const headers = cleaned[0].map((h) => String(h).trim().toLowerCase());
  const rows = cleaned.slice(1).map((row) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = row[idx] !== undefined ? String(row[idx]).trim() : "";
    });
    return obj;
  });

  return { headers, rows };
};
