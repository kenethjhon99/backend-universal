import bcrypt from "bcrypt";

const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);

export const isBcryptHash = (value) => {
  return /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/.test(String(value || ""));
};

export const validatePasswordPolicy = (password) => {
  if (typeof password !== "string" || password.length < 4) {
    const error = new Error("password requerido (minimo 4)");
    error.statusCode = 400;
    throw error;
  }
};

export const hashPassword = async (password) => {
  validatePasswordPolicy(password);
  return bcrypt.hash(password, BCRYPT_ROUNDS);
};

export const verifyPasswordWithUpgrade = async ({
  plainPassword,
  storedPasswordHash,
  onLegacyUpgrade,
}) => {
  if (!storedPasswordHash) return false;

  if (isBcryptHash(storedPasswordHash)) {
    return bcrypt.compare(plainPassword, storedPasswordHash);
  }

  if (plainPassword !== storedPasswordHash) {
    return false;
  }

  if (typeof onLegacyUpgrade === "function") {
    const upgradedHash = await hashPassword(plainPassword);
    await onLegacyUpgrade(upgradedHash);
  }

  return true;
};
