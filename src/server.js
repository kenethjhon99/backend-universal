import app from "./app.js";
import { testDB } from "./config/db.js";

await testDB();

app.listen(process.env.PORT || 3000, () =>
  console.log("🚀 Servidor en puerto", process.env.PORT || 3000)
);
