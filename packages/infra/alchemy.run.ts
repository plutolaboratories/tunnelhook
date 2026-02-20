import alchemy from "alchemy";
import {
  D1Database,
  DurableObjectNamespace,
  Vite,
  Worker,
} from "alchemy/cloudflare";
import { CloudflareStateStore } from "alchemy/state";
import { config } from "dotenv";

config({ path: "./.env" });
config({ path: "../../apps/web/.env" });
config({ path: "../../apps/server/.env" });

const app = await alchemy("tunnelhook", {
  stage: "shkumbinhasani",
  stateStore: process.env.CI
    ? (scope) => new CloudflareStateStore(scope)
    : undefined,
});

const db = await D1Database("database", {
  migrationsDir: "../../packages/db/src/migrations",
});

export const web = await Vite("web", {
  cwd: "../../apps/web",
  assets: "dist",
  bindings: {
    VITE_SERVER_URL: alchemy.env.VITE_SERVER_URL!,
  },
});

export const server = await Worker("server", {
  cwd: "../../apps/server",
  entrypoint: "src/index.ts",
  compatibility: "node",
  bindings: {
    DB: db,
    CORS_ORIGIN: alchemy.env.CORS_ORIGIN!,
    BETTER_AUTH_SECRET: alchemy.secret.env.BETTER_AUTH_SECRET!,
    BETTER_AUTH_URL: alchemy.env.BETTER_AUTH_URL!,
    ENDPOINT_DO: DurableObjectNamespace("endpoint-do", {
      className: "EndpointDO",
    }),
  },
  dev: {
    port: 3002,
  },
});

console.log(`Web    -> ${web.url}`);
console.log(`Server -> ${server.url}`);

await app.finalize();
