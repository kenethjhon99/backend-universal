import { applyRequestSettings, pool } from "../../config/db.js";

export const runInTransaction = async (work, { auth = null } = {}) => {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    if (auth) {
      await applyRequestSettings(client, auth);
    }

    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

