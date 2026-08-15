import { parseRuntimeConfig } from "./config.js";
import { createApp } from "./server.js";
import { openStore } from "./store.js";

async function main(): Promise<void> {
  const config = parseRuntimeConfig(process.env);
  const store = await openStore(
    config.dataDir,
    config.store,
    { requireLegacyImport: config.requireLegacyImport },
  );
  const app = createApp({
    store,
    readTokenDigest: config.readTokenDigest,
    edgeCredentials: config.edgeCredentials,
    invalidAuthMaxAttempts: config.invalidAuthMaxAttempts,
    invalidAuthWindowMs: config.invalidAuthWindowMs,
  });

  const server = Bun.serve({
    port: config.port,
    hostname: "0.0.0.0",
    fetch(request, bunServer) {
      const client = bunServer.requestIP(request);
      const clientKey = client ? `${client.family}:${client.address}` : "unknown";
      return app.fetch(request, clientKey);
    },
  });

  let stopping = false;
  function stop(): void {
    if (stopping) return;
    stopping = true;
    server.stop(true);
    store.close();
  }
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  console.log(`usage aggregator schema 3 listening on :${server.port}`);
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown startup failure";
  // Configuration validators never include a presented token or JSON value in
  // their errors. Do not print an exception object, which could acquire secret
  // fields from a future dependency.
  console.error(`usage aggregator failed to start: ${message}`);
  process.exit(1);
}
