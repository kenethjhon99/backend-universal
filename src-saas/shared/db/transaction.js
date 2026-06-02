import { applyRequestSettings, pool } from "../../config/db.js";

export const runInTransaction = async (work, { auth = null, dbContext = null } = {}) => {
  const client = dbContext || await pool.connect();
  const isNewConnection = !dbContext;

  try {
    await client.query("BEGIN");

    if (auth && isNewConnection) {
      await applyRequestSettings(client, auth);
    }

    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    if (isNewConnection) {
      client.release();
    }
  }
};

