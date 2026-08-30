import { pathToFileURL } from "node:url";
import { buildApp } from "./app";

export async function startServer(): Promise<void> {
  const app = await buildApp({ logger: true });
  const port = Number.parseInt(process.env.PORT ?? "8787", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid PORT: ${process.env.PORT ?? ""}`);
  }
  const host = process.env.HOST ?? "100.65.64.80";

  const close = async (): Promise<void> => {
    await app.close();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());

  await app.listen({ host, port });
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  startServer().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
