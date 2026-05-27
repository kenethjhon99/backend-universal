import { runInTransaction } from "../../shared/db/transaction.js";
import { writeAuditEvent } from "../../shared/audit/audit-log.js";
import { HttpError } from "../../shared/http/http-error.js";
import { pool } from "../../config/db.js";

export const listSucursales = async ({ auth }) => {
  const result = await pool.query(
    `
      select
        s.*,
        (
          select count(*)::int
          from usuarios_sucursales us
          where us.id_empresa = s.id_empresa
            and us.id_sucursal = s.id_sucursal
        ) as total_usuarios_asignados
      from sucursales s
      where s.id_empresa = $1
      order by s.es_principal desc, s.nombre asc
    `,
    [auth.id_empresa]
  );

  return result.rows;
};

export const createSucursal = async ({ auth, scope, body, requestMeta }) =>
  runInTransaction(
    async (client) => {
      const codigo = String(body?.codigo || "").trim().toUpperCase();
      const nombre = String(body?.nombre || "").trim();

      if (!codigo || !nombre) {
        throw HttpError.badRequest("codigo y nombre son requeridos");
      }

      const result = await client.query(
        `
          insert into sucursales (
            id_empresa,
            codigo,
            nombre,
            direccion,
            telefono,
            es_principal,
            activa,
            created_by,
            updated_by
          )
          values ($1,$2,$3,$4,$5,false,true,$6,$6)
          returning *
        `,
        [
          auth.id_empresa,
          codigo,
          nombre,
          body?.direccion || null,
          body?.telefono || null,
          auth.id_usuario,
        ]
      );

      const branch = result.rows[0];

      const warehouseResult = await client.query(
        `
          insert into bodegas (
            id_empresa,
            id_sucursal,
            codigo,
            nombre,
            es_principal,
            activa,
            created_by,
            updated_by
          )
          values ($1,$2,'PRINCIPAL','Bodega principal',true,true,$3,$3)
          returning id_bodega
        `,
        [auth.id_empresa, branch.id_sucursal, auth.id_usuario]
      );
      const idBodega = warehouseResult.rows[0].id_bodega;

      await client.query(
        `
          insert into stock_sucursal (
            id_empresa,
            id_sucursal,
            id_bodega,
            id_producto,
            stock_actual,
            stock_minimo,
            created_by,
            updated_by
          )
          select
            p.id_empresa,
            $2,
            $3,
            p.id_producto,
            0,
            0,
            $4,
            $4
          from productos p
          where p.id_empresa = $1
            and p.activo = true
        `,
        [auth.id_empresa, branch.id_sucursal, idBodega, auth.id_usuario]
      );

      await writeAuditEvent(client, {
        auth,
        scope,
        requestMeta,
        modulo: "SUCURSALES",
        entidad: "SUCURSAL",
        entidadId: branch.id_sucursal,
        accion: "CREATE",
        despues: {
          id_sucursal: branch.id_sucursal,
          codigo: branch.codigo,
          nombre: branch.nombre,
          direccion: branch.direccion,
          telefono: branch.telefono,
        },
      });

      return branch;
    },
    { auth }
  );
