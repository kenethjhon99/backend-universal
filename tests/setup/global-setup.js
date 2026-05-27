// Carga variables de entorno desde un .env.test si existe.
// Si no, usa los valores PG* del entorno actual.
import dotenv from "dotenv";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const envTestPath = resolve(process.cwd(), ".env.test");

if (existsSync(envTestPath)) {
  dotenv.config({ path: envTestPath });
} else {
  dotenv.config();
}

if (!process.env.PGDATABASE) {
  // eslint-disable-next-line no-console
  console.warn(
    "[tests] PGDATABASE no esta definido. Crea un .env.test apuntando a una BD de pruebas vacia antes de correr 'npm test'."
  );
}
