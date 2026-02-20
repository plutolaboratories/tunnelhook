import { db } from "@tunnelhook/db";
import { endpoint } from "@tunnelhook/db/schema";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { protectedProcedure } from "../index";

function generateId(): string {
  return crypto.randomUUID();
}

function generateSlug(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let slug = "";
  for (let i = 0; i < 12; i++) {
    slug += chars[Math.floor(Math.random() * chars.length)];
  }
  return slug;
}

export const endpointRouter = {
  /** Create a new webhook endpoint */
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        slug: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/)
          .optional(),
        description: z.string().max(500).optional(),
        forwardUrl: z.url().optional(),
      })
    )
    .handler(async ({ input, context }) => {
      const id = generateId();
      const slug = input.slug ?? generateSlug();
      const userId = context.session.user.id;

      await db.insert(endpoint).values({
        id,
        slug,
        name: input.name,
        description: input.description ?? null,
        forwardUrl: input.forwardUrl ?? null,
        userId,
        enabled: true,
      });

      const created = await db.query.endpoint.findFirst({
        where: eq(endpoint.id, id),
      });

      return created;
    }),

  /** List all endpoints for the current user */
  list: protectedProcedure.handler(async ({ context }) => {
    const userId = context.session.user.id;
    const endpoints = await db.query.endpoint.findMany({
      where: eq(endpoint.userId, userId),
      orderBy: [desc(endpoint.createdAt)],
    });
    return endpoints;
  }),

  /** Get a single endpoint by ID */
  get: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) => {
      const result = await db.query.endpoint.findFirst({
        where: eq(endpoint.id, input.id),
      });
      if (!result || result.userId !== context.session.user.id) {
        throw new Error("Endpoint not found");
      }
      return result;
    }),

  /** Update an endpoint */
  update: protectedProcedure
    .input(
      z.object({
        id: z.string(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(500).optional(),
        forwardUrl: z.url().nullable().optional(),
        enabled: z.boolean().optional(),
      })
    )
    .handler(async ({ input, context }) => {
      const existing = await db.query.endpoint.findFirst({
        where: eq(endpoint.id, input.id),
      });
      if (!existing || existing.userId !== context.session.user.id) {
        throw new Error("Endpoint not found");
      }

      const updates: Record<string, unknown> = {};
      if (input.name !== undefined) {
        updates.name = input.name;
      }
      if (input.description !== undefined) {
        updates.description = input.description;
      }
      if (input.forwardUrl !== undefined) {
        updates.forwardUrl = input.forwardUrl;
      }
      if (input.enabled !== undefined) {
        updates.enabled = input.enabled;
      }

      await db.update(endpoint).set(updates).where(eq(endpoint.id, input.id));

      return db.query.endpoint.findFirst({
        where: eq(endpoint.id, input.id),
      });
    }),

  /** Delete an endpoint */
  delete: protectedProcedure
    .input(z.object({ id: z.string() }))
    .handler(async ({ input, context }) => {
      const existing = await db.query.endpoint.findFirst({
        where: eq(endpoint.id, input.id),
      });
      if (!existing || existing.userId !== context.session.user.id) {
        throw new Error("Endpoint not found");
      }

      await db.delete(endpoint).where(eq(endpoint.id, input.id));
      return { success: true };
    }),
};
