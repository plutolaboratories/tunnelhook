import type { RouterClient } from "@orpc/server";

import { protectedProcedure, publicProcedure } from "../index";
import { deliveryRouter } from "./deliveries";
import { endpointRouter } from "./endpoints";
import { eventRouter } from "./events";
import { machineRouter } from "./machines";

export const appRouter = {
  healthCheck: publicProcedure.handler(() => {
    return "OK";
  }),
  privateData: protectedProcedure.handler(({ context }) => {
    return {
      message: "This is private",
      user: context.session?.user,
    };
  }),
  endpoints: endpointRouter,
  events: eventRouter,
  machines: machineRouter,
  deliveries: deliveryRouter,
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
