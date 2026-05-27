# Métricas Prometheus

## Endpoint

```
GET /metrics
```

Devuelve texto plano en formato Prometheus exposition format.

### Autenticación opcional

Si seteas la variable de entorno `METRICS_TOKEN`, el endpoint exige uno de:
- Header `X-Metrics-Token: <token>`
- Header `Authorization: Bearer <token>`

Si no seteas `METRICS_TOKEN`, el endpoint queda abierto. Recomendado:
- En cluster privado / red interna: dejar abierto.
- Si el endpoint es accesible desde internet: setear token.

## Métricas expuestas

### Default (proceso Node)
- `process_cpu_*`
- `process_resident_memory_bytes`
- `nodejs_eventloop_lag_*`
- `nodejs_active_handles`
- `nodejs_gc_duration_seconds`
- ...

### HTTP
| Métrica | Tipo | Labels |
|---|---|---|
| `http_requests_total` | counter | `method`, `route`, `status_code` |
| `http_request_duration_ms` | histogram | `method`, `route`, `status_code` |

Las rutas se normalizan: `/api/saas/ventas/12345` → `/api/saas/ventas/:id`
para evitar explosión de cardinalidad.

### Negocio
| Métrica | Tipo | Labels |
|---|---|---|
| `saas_ventas_creadas_total` | counter | `empresa`, `tipo_venta`, `metodo_pago`, `estado` |
| `saas_ventas_reversiones_total` | counter | `empresa`, `tipo_reversion`, `metodo_resolucion` |
| `saas_ordenes_servicio_total` | counter | `empresa`, `modulo` |
| `saas_caja_sesiones_abiertas` | gauge | `empresa` |
| `saas_login_attempts_total` | counter | `result` (`success` \| `invalid_credentials` \| `inactive` \| `error`) |
| `saas_refresh_token_events_total` | counter | `event` (`issued` \| `rotated` \| `reused_revoked` \| `revoked_logout`) |
| `saas_db_query_duration_ms` | histogram | `module`, `operation` |

## Configuración de Prometheus

`prometheus.yml`:

```yaml
scrape_configs:
  - job_name: pos-saas-api
    metrics_path: /metrics
    scrape_interval: 15s
    static_configs:
      - targets: ["api.tu-dominio:4000"]
    # Si usas METRICS_TOKEN:
    authorization:
      type: Bearer
      credentials: <tu-token>
```

## Alertas sugeridas

```yaml
groups:
  - name: pos-saas
    rules:
      - alert: HighErrorRate
        expr: |
          sum(rate(http_requests_total{status_code=~"5.."}[5m]))
            / sum(rate(http_requests_total[5m])) > 0.02
        for: 5m
        annotations:
          summary: "Mas del 2% de respuestas son 5xx en los ultimos 5 min"

      - alert: HighLatencyP95
        expr: |
          histogram_quantile(0.95,
            sum(rate(http_request_duration_ms_bucket[5m])) by (le, route)
          ) > 1000
        for: 10m
        annotations:
          summary: "Latencia p95 > 1s en {{ $labels.route }}"

      - alert: BruteForceLogin
        expr: |
          rate(saas_login_attempts_total{result="invalid_credentials"}[5m]) > 0.5
        for: 5m
        annotations:
          summary: "Mas de 0.5 intentos fallidos por seg sostenido. Posible brute force."

      - alert: RefreshTokenReused
        expr: |
          increase(saas_refresh_token_events_total{event="reused_revoked"}[10m]) > 0
        for: 1m
        annotations:
          summary: "Reuso de refresh token detectado. Posible robo de credenciales."

      - alert: EventLoopLagHigh
        expr: nodejs_eventloop_lag_p95_seconds > 0.2
        for: 5m
        annotations:
          summary: "event loop lag p95 > 200ms (proceso saturado)"
```

## Dashboard Grafana mínimo

Paneles sugeridos:
1. **RPS** — `sum(rate(http_requests_total[1m])) by (status_code)`
2. **Latencia p50/p95/p99** — `histogram_quantile(0.95, sum(rate(http_request_duration_ms_bucket[5m])) by (le))`
3. **Error rate %** — ratio de 5xx sobre total
4. **Top routes lentas** — top10 p95 por route
5. **Ventas por hora** — `sum(rate(saas_ventas_creadas_total[1h])) by (empresa)`
6. **Login fails / minuto** — `sum(rate(saas_login_attempts_total{result!="success"}[1m]))`
7. **Reversiones de venta** — `sum(rate(saas_ventas_reversiones_total[1h])) by (tipo_reversion)`

## Uso en el código

Instrumentar una operación de BD:

```js
import { measureDb } from "../shared/metrics/registry.js";

const result = await measureDb("ventas", "createVenta", () =>
  pool.query("...")
);
```

Contadores custom:

```js
import { ventasCreated } from "../shared/metrics/registry.js";

ventasCreated.inc({
  empresa: String(idEmpresa),
  tipo_venta: "CONTADO",
  metodo_pago: "EFECTIVO",
  estado: "CONFIRMADA",
});
```
