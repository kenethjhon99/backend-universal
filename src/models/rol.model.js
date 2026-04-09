import { pool } from "../config/db.js";

export const getRoles = async () => {
  const r = await pool.query(`
    SELECT
      MIN(id_rol) AS id_rol,
      CASE
        WHEN UPPER(TRIM(nombre_rol)) = 'SUPERADMIN' THEN 'SUPER_ADMIN'
        ELSE UPPER(TRIM(nombre_rol))
      END AS nombre_rol
    FROM "Rol"
    WHERE CASE
      WHEN UPPER(TRIM(nombre_rol)) = 'SUPERADMIN' THEN 'SUPER_ADMIN'
      ELSE UPPER(TRIM(nombre_rol))
    END IN (
      'SUPER_ADMIN',
      'ADMIN',
      'CAJERO',
      'MECANICO',
      'LECTURA',
      'ENCARGADO_SERVICIOS'
    )
    GROUP BY CASE
      WHEN UPPER(TRIM(nombre_rol)) = 'SUPERADMIN' THEN 'SUPER_ADMIN'
      ELSE UPPER(TRIM(nombre_rol))
    END
    ORDER BY MIN(id_rol) ASC
  `);
  return r.rows;
};
