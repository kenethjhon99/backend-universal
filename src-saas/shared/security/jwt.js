import jwt from "jsonwebtoken";
import { env } from "../../config/env.js";

// Access token corto. Default 30min. El cliente refresca usando el cookie
// httpOnly del refresh token.
const ACCESS_EXPIRES = process.env.JWT_ACCESS_EXPIRES || "30m";

export const signAccessToken = (payload, opts = {}) =>
  jwt.sign(payload, env.jwtSecret, {
    expiresIn: opts.expiresIn || ACCESS_EXPIRES,
  });

export const verifyAccessToken = (token) =>
  jwt.verify(token, env.jwtSecret);
