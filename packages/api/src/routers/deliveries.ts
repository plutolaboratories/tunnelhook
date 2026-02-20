import { db } from "@tunnelhook/db";
import { delivery, endpoint, event, machine } from "@tunnelhook/db/schema";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";

import { protectedProcedure } from "../index";

export const deliveryRouter = {
  /** List deliveries for a specific event */
  listByEvent: protectedProcedure
    .input(z.object({ eventId: z.string() }))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;

      // Verify event ownership through endpoint (separate lookups to avoid drizzle dedup type issues)
      const ev = await db.query.event.findFirst({
        where: eq(event.id, input.eventId),
      });
      if (!ev) {
        throw new ORPCError("NOT_FOUND", { message: "Event not found" });
      }

      const ep = await db.query.endpoint.findFirst({
        where: eq(endpoint.id, ev.endpointId),
      });
      if (!ep || ep.userId !== userId) {
        throw new ORPCError("NOT_FOUND", { message: "Event not found" });
      }

      const deliveries = await db
        .select({
          id: delivery.id,
          eventId: delivery.eventId,
          machineId: delivery.machineId,
          status: delivery.status,
          responseStatus: delivery.responseStatus,
          responseBody: delivery.responseBody,
          error: delivery.error,
          duration: delivery.duration,
          createdAt: delivery.createdAt,
          machineName: machine.name,
          machineForwardUrl: machine.forwardUrl,
        })
        .from(delivery)
        .leftJoin(machine, eq(delivery.machineId, machine.id))
        .where(eq(delivery.eventId, input.eventId))
        .orderBy(desc(delivery.createdAt));

      return deliveries;
    }),

  /** List deliveries for a specific machine */
  listByMachine: protectedProcedure
    .input(
      z.object({
        machineId: z.string(),
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;

      // Verify machine ownership
      const m = await db.query.machine.findFirst({
        where: eq(machine.id, input.machineId),
      });
      if (!m || m.userId !== userId) {
        throw new ORPCError("NOT_FOUND", { message: "Machine not found" });
      }

      const deliveries = await db
        .select({
          id: delivery.id,
          eventId: delivery.eventId,
          machineId: delivery.machineId,
          status: delivery.status,
          responseStatus: delivery.responseStatus,
          responseBody: delivery.responseBody,
          error: delivery.error,
          duration: delivery.duration,
          createdAt: delivery.createdAt,
          eventMethod: event.method,
          eventContentType: event.contentType,
          eventCreatedAt: event.createdAt,
        })
        .from(delivery)
        .leftJoin(event, eq(delivery.eventId, event.id))
        .where(eq(delivery.machineId, input.machineId))
        .orderBy(desc(delivery.createdAt))
        .limit(input.limit);

      return deliveries;
    }),

  /** Get a single delivery by ID */
  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) => {
      const result = await db.query.delivery.findFirst({
        where: eq(delivery.id, input.id),
      });
      if (!result) {
        throw new ORPCError("NOT_FOUND", { message: "Delivery not found" });
      }

      // Verify ownership through machine (separate lookup)
      const m = await db.query.machine.findFirst({
        where: eq(machine.id, result.machineId),
      });
      if (!m || m.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Delivery not found" });
      }

      return {
        ...result,
        machineName: m.name,
        machineForwardUrl: m.forwardUrl,
      };
    }),
};
