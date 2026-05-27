export const getRequestMeta = (req) => ({
  ip:
    String(req.headers["x-forwarded-for"] || "")
      .split(",")[0]
      .trim() || req.ip || null,
  userAgent: req.get("user-agent") || null,
});
