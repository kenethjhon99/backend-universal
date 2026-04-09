const TZ = "America/Guatemala";

export const toLocalGT = (value) => {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return value; // por si viniera raro

  return d.toLocaleString("es-GT", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
};

// Convierte un objeto/array: agrega <campo>_local y <campo>_utc
export const addLocalDates = (data, fields = ["fecha", "anulada_en"]) => {
  const handleObj = (obj) => {
    if (!obj || typeof obj !== "object") return obj;

    for (const f of fields) {
      if (obj[f] !== undefined) {
        obj[`${f}_utc`] = obj[f];         // lo original
        obj[`${f}_local`] = toLocalGT(obj[f]);
      }
    }
    return obj;
  };

  if (Array.isArray(data)) return data.map(handleObj);
  return handleObj(data);
};