export const toChart = (rows, labelKey, valueKey) => {
  const labels = rows.map(r => String(r[labelKey] ?? ""));
  const values = rows.map(r => Number(r[valueKey] ?? 0));
  return { labels, values };
};