#!/usr/bin/env node
import dotenv from "dotenv";

dotenv.config();

const baseUrl =
  process.env.SAAS_API_URL ||
  `http://localhost:${process.env.PORT || 4000}/api/saas`;

const fail = (message) => {
  console.error(`[prod-check] FAIL: ${message}`);
  process.exitCode = 1;
};

const getJson = async (path) => {
  const response = await fetch(`${baseUrl}${path}`);
  const data = await response.json().catch(() => null);
  return { response, data };
};

const main = async () => {
  console.log(`[prod-check] API: ${baseUrl}`);

  const live = await getJson("/live");
  if (!live.response.ok || live.data?.ok !== true) {
    fail(`/live no responde OK (${live.response.status})`);
  } else {
    console.log(`[prod-check] live OK uptime=${live.data.uptime_seconds}s`);
  }

  const ready = await getJson("/ready");
  if (!ready.response.ok || ready.data?.ok !== true) {
    fail(`/ready no esta listo (${ready.response.status})`);
  }

  for (const item of ready.data?.checks || []) {
    const icon = item.status === "ok" ? "OK" : item.status.toUpperCase();
    console.log(
      `[prod-check] ${icon} ${item.name} severity=${item.severity}${
        item.message ? ` message="${item.message}"` : ""
      }`
    );
    if (item.status === "fail" && item.severity === "critical") {
      fail(`check critico fallido: ${item.name}`);
    }
  }

  if (process.exitCode) return;
  console.log("[prod-check] OK");
};

main().catch((error) => {
  fail(error.message);
});
