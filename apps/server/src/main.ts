import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { connectDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const db = connectDb(config.DATABASE_URL);
  await runMigrations(db);
  const { app, services } = await buildApp({ config, db });

  const shutdown = async (): Promise<void> => {
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await app.listen({ port: config.PORT, host: config.HOST });
  const resumed = await services.tasks.resumeAll();
  if (resumed > 0) app.log.info({ resumed }, "resumed unfinished tasks");
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
