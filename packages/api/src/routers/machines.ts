import { db } from "@tunnelhook/db";
import { delivery, endpoint, machine } from "@tunnelhook/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { protectedProcedure } from "../index";

export const machineRouter = {
  /** Register a new machine for an endpoint */
  register: protectedProcedure
    .input(
      z.object({
        endpointId: z.string(),
        name: z.string().min(1).max(100),
        forwardUrl: z.url(),
      })
    )
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;

      // Verify endpoint ownership
      const ep = await db.query.endpoint.findFirst({
        where: eq(endpoint.id, input.endpointId),
      });
      if (!ep || ep.userId !== userId) {
        throw new ORPCError("NOT_FOUND", { message: "Endpoint not found" });
      }

      const id = crypto.randomUUID();

      await db.insert(machine).values({
        id,
        name: input.name,
        endpointId: input.endpointId,
        userId,
        forwardUrl: input.forwardUrl,
        status: "offline",
      });

      const created = await db.query.machine.findFirst({
        where: eq(machine.id, id),
      });

      return created;
    }),

  /** List machines for an endpoint */
  list: protectedProcedure
    .input(z.object({ endpointId: z.string() }))
    .handler(async ({ input, context }) => {
      const userId = context.session.user.id;

      // Verify endpoint ownership
      const ep = await db.query.endpoint.findFirst({
        where: eq(endpoint.id, input.endpointId),
      });
      if (!ep || ep.userId !== userId) {
        throw new ORPCError("NOT_FOUND", { message: "Endpoint not found" });
      }

      const machines = await db.query.machine.findMany({
        where: eq(machine.endpointId, input.endpointId),
      });

      return machines;
    }),

  /** Get a single machine */
  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) => {
      const result = await db.query.machine.findFirst({
        where: eq(machine.id, input.id),
      });
      if (!result || result.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Machine not found" });
      }
      return result;
    }),

  /** Update a machine */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(100).optional(),
        forwardUrl: z.url().optional(),
      })
    )
    .handler(async ({ input, context }) => {
      const existing = await db.query.machine.findFirst({
        where: eq(machine.id, input.id),
      });
      if (!existing || existing.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Machine not found" });
      }

      const updates: Record<string, unknown> = {};
      if (input.name !== undefined) {
        updates.name = input.name;
      }
      if (input.forwardUrl !== undefined) {
        updates.forwardUrl = input.forwardUrl;
      }

      await db.update(machine).set(updates).where(eq(machine.id, input.id));

      return db.query.machine.findFirst({
        where: eq(machine.id, input.id),
      });
    }),

  /** Delete a machine */
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) => {
      const existing = await db.query.machine.findFirst({
        where: eq(machine.id, input.id),
      });
      if (!existing || existing.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Machine not found" });
      }

      await db.delete(machine).where(eq(machine.id, input.id));
      return { success: true };
    }),

  /** Report a delivery result (called by TUI/CLI after forwarding locally) */
  reportDelivery: protectedProcedure
    .input(
      z.object({
        deliveryId: z.string(),
        status: z.enum(["delivered", "failed"]),
        responseStatus: z.number().nullable(),
        responseBody: z.string().max(10_000).nullable(),
        error: z.string().max(2000).nullable(),
        duration: z.number().nullable(),
      })
    )
    .handler(async ({ input, context }) => {
      const existing = await db.query.delivery.findFirst({
        where: eq(delivery.id, input.deliveryId),
      });
      if (!existing) {
        throw new ORPCError("NOT_FOUND", { message: "Delivery not found" });
      }

      // Verify ownership through machine (separate lookup to avoid drizzle dedup type issues)
      const m = await db.query.machine.findFirst({
        where: eq(machine.id, existing.machineId),
      });
      if (!m || m.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Delivery not found" });
      }

      await db
        .update(delivery)
        .set({
          status: input.status,
          responseStatus: input.responseStatus,
          responseBody: input.responseBody,
          error: input.error,
          duration: input.duration,
        })
        .where(eq(delivery.id, input.deliveryId));

      return { success: true };
    }),
};
