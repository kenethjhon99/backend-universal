/**
 * Diff estructurado de dos objetos JSON. Devuelve la lista de cambios
 * con path, valor anterior y nuevo. Pensado para mostrar antes/después
 * en la UI de auditoría.
 *
 * No usa libs externas. Soporta nested objects y arrays primitivos.
 * Arrays de objetos se comparan como "set" (sin orden, identidad simple).
 */

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const equalsPrimitive = (a, b) => {
  if (a === b) return true;
  if (a == null && b == null) return true;
  return String(a) === String(b);
};

const equalsValue = (a, b) => {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => equalsValue(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => equalsValue(a[k], b[k]));
  }
  return equalsPrimitive(a, b);
};

/**
 * Recorre dos objetos y produce lista de cambios.
 *  - tipo: "added" | "removed" | "modified"
 *  - path: notación dot ("cliente.nombre", "items[0].cantidad")
 *  - antes / despues: valores
 */
export const computeDiff = (before, after) => {
  const changes = [];

  const walk = (a, b, path) => {
    if (equalsValue(a, b)) return;

    // Tipos distintos o uno es primitivo y el otro no
    if (
      !isObject(a) ||
      !isObject(b) ||
      Array.isArray(a) !== Array.isArray(b)
    ) {
      changes.push({
        path: path || "(root)",
        type: "modified",
        before: a === undefined ? null : a,
        after: b === undefined ? null : b,
      });
      return;
    }

    if (Array.isArray(a)) {
      // arrays: comparar por índice (simple). Para "diff inteligente"
      // de arrays grandes haría falta heurística por id; aquí un MVP.
      const max = Math.max(a.length, b.length);
      for (let i = 0; i < max; i += 1) {
        const subPath = `${path}[${i}]`;
        if (i >= a.length) {
          changes.push({ path: subPath, type: "added", before: null, after: b[i] });
        } else if (i >= b.length) {
          changes.push({ path: subPath, type: "removed", before: a[i], after: null });
        } else {
          walk(a[i], b[i], subPath);
        }
      }
      return;
    }

    // Ambos objetos: recorrer keys
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      const subPath = path ? `${path}.${key}` : key;
      if (!(key in a)) {
        changes.push({ path: subPath, type: "added", before: null, after: b[key] });
      } else if (!(key in b)) {
        changes.push({ path: subPath, type: "removed", before: a[key], after: null });
      } else {
        walk(a[key], b[key], subPath);
      }
    }
  };

  walk(before, after, "");
  return changes;
};

/**
 * Resumen compacto: cuenta cambios por tipo y devuelve los primeros N.
 */
export const summarizeDiff = (before, after, top = 10) => {
  const changes = computeDiff(before || {}, after || {});
  const byType = changes.reduce(
    (acc, c) => {
      acc[c.type] = (acc[c.type] || 0) + 1;
      return acc;
    },
    {}
  );

  return {
    total_cambios: changes.length,
    por_tipo: byType,
    cambios: changes.slice(0, top),
  };
};
