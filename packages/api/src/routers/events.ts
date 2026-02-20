import { db } from "@tunnelhook/db";
import { endpoint, event } from "@tunnelhook/db/schema";
import { and, desc, eq, lt } from "drizzle-orm";
import { z } from "zod";

import { protectedProcedure } from "../index";

export const eventRouter = {
  /** List events for an endpoint with cursor-based pagination */
  list: protectedProcedure
    .input(
      z.object({
        endpointId: z.string(),
        cursor: z.number().optional(),
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .handler(async ({ input, context }) => {
      // Verify endpoint ownership
      const ep = await db.query.endpoint.findFirst({
        where: eq(endpoint.id, input.endpointId),
      });
      if (!ep || ep.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Endpoint not found" });
      }

      const conditions = [eq(event.endpointId, input.endpointId)];
      if (input.cursor) {
        conditions.push(lt(event.createdAt, input.cursor));
      }

      const events = await db.query.event.findMany({
        where: and(...conditions),
        orderBy: [desc(event.createdAt)],
        limit: input.limit + 1,
      });

      const hasMore = events.length > input.limit;
      const items = hasMore ? events.slice(0, input.limit) : events;
      const nextCursor = hasMore ? items.at(-1)?.createdAt : undefined;

      return {
        items,
        nextCursor,
      };
    }),

  /** Get a single event by ID */
  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) => {
      const result = await db.query.event.findFirst({
        where: eq(event.id, input.id),
        with: { endpoint: true },
      });
      if (!result || result.endpoint.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Event not found" });
      }
      return result;
    }),

  /** Delete an event */
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) => {
      const result = await db.query.event.findFirst({
        where: eq(event.id, input.id),
        with: { endpoint: true },
      });
      if (!result || result.endpoint.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Event not found" });
      }

      await db.delete(event).where(eq(event.id, input.id));
      return { success: true };
    }),

  /** Clear all events for an endpoint */
  clear: protectedProcedure
    .input(z.object({ endpointId: z.string() }))
    .handler(async ({ input, context }) => {
      const ep = await db.query.endpoint.findFirst({
        where: eq(endpoint.id, input.endpointId),
      });
      if (!ep || ep.userId !== context.session.user.id) {
        throw new ORPCError("NOT_FOUND", { message: "Endpoint not found" });
      }

      await db.delete(event).where(eq(event.endpointId, input.endpointId));
      return { success: true };
    }),
};
