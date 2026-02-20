import { relations, sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { user } from "./auth";

/**
 * A webhook endpoint — a reusable URL that receives incoming webhooks.
 * Each endpoint belongs to a user and has a unique slug used in the URL.
 */
export const endpoint = sqliteTable(
  "endpoint",
  {
    id: text("id").primaryKey(),
    /** Human-readable name, e.g. "Stripe Production" */
    name: text("name").notNull(),
    /** Unique slug used in the webhook URL: /hooks/:slug */
    slug: text("slug").notNull().unique(),
    /** Optional description */
    description: text("description"),
    /** Owner of the endpoint */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** Whether the endpoint is active and accepting webhooks */
    enabled: integer("enabled", { mode: "boolean" }).default(true).notNull(),
    /** Optional destination URL to forward webhooks to */
    forwardUrl: text("forward_url"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("endpoint_userId_idx").on(table.userId),
    index("endpoint_slug_idx").on(table.slug),
  ]
);

/**
 * A captured webhook event — stores every incoming request to an endpoint.
 */
export const event = sqliteTable(
  "event",
  {
    id: text("id").primaryKey(),
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => endpoint.id, { onDelete: "cascade" }),
    /** HTTP method of the incoming request */
    method: text("method").notNull(),
    /** Request headers stored as JSON */
    headers: text("headers").notNull(),
    /** Request body (raw string) */
    body: text("body"),
    /** Query string */
    query: text("query"),
    /** Source IP address */
    sourceIp: text("source_ip"),
    /** Content type of the request */
    contentType: text("content_type"),
    /** HTTP status code returned when forwarding (null if not forwarded) */
    forwardStatus: integer("forward_status"),
    /** Error message if forwarding failed */
    forwardError: text("forward_error"),
    /** Response time in ms when forwarding */
    forwardDuration: integer("forward_duration"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("event_endpointId_idx").on(table.endpointId),
    index("event_createdAt_idx").on(table.createdAt),
  ]
);

/**
 * A machine — a connected CLI/TUI client that subscribes to an endpoint.
 * Each machine has a local forward URL where it receives webhooks.
 */
export const machine = sqliteTable(
  "machine",
  {
    id: text("id").primaryKey(),
    /** Human-readable machine name, e.g. "Shkumbin's MacBook" */
    name: text("name").notNull(),
    /** The endpoint this machine is subscribed to */
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => endpoint.id, { onDelete: "cascade" }),
    /** Owner of the machine */
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    /** The local URL where this machine forwards webhooks, e.g. http://localhost:3000/webhook */
    forwardUrl: text("forward_url").notNull(),
    /** Current connection status */
    status: text("status", {
      enum: ["online", "offline"],
    })
      .default("offline")
      .notNull(),
    /** Last time this machine was seen connected */
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("machine_endpointId_idx").on(table.endpointId),
    index("machine_userId_idx").on(table.userId),
  ]
);

/**
 * A delivery — tracks each time a webhook event was delivered to a machine.
 * Records the HTTP response status, body, and timing from the machine's local server.
 */
export const delivery = sqliteTable(
  "delivery",
  {
    id: text("id").primaryKey(),
    /** The event that was delivered */
    eventId: text("event_id")
      .notNull()
      .references(() => event.id, { onDelete: "cascade" }),
    /** The machine it was delivered to */
    machineId: text("machine_id")
      .notNull()
      .references(() => machine.id, { onDelete: "cascade" }),
    /** Delivery status */
    status: text("status", {
      enum: ["pending", "delivered", "failed"],
    })
      .default("pending")
      .notNull(),
    /** HTTP status code returned by the machine's local server */
    responseStatus: integer("response_status"),
    /** Response body from the machine's local server (truncated) */
    responseBody: text("response_body"),
    /** Error message if delivery failed */
    error: text("error"),
    /** Delivery duration in ms */
    duration: integer("duration"),
    createdAt: integer("created_at", { mode: "timestamp_ms" })
      .default(sql`(cast(unixepoch('subsecond') * 1000 as integer))`)
      .notNull(),
  },
  (table) => [
    index("delivery_eventId_idx").on(table.eventId),
    index("delivery_machineId_idx").on(table.machineId),
  ]
);

export const endpointRelations = relations(endpoint, ({ one, many }) => ({
  user: one(user, {
    fields: [endpoint.userId],
    references: [user.id],
  }),
  events: many(event),
  machines: many(machine),
}));

export const eventRelations = relations(event, ({ one, many }) => ({
  endpoint: one(endpoint, {
    fields: [event.endpointId],
    references: [endpoint.id],
  }),
  deliveries: many(delivery),
}));

export const machineRelations = relations(machine, ({ one, many }) => ({
  endpoint: one(endpoint, {
    fields: [machine.endpointId],
    references: [endpoint.id],
  }),
  user: one(user, {
    fields: [machine.userId],
    references: [user.id],
  }),
  deliveries: many(delivery),
}));

export const deliveryRelations = relations(delivery, ({ one }) => ({
  event: one(event, {
    fields: [delivery.eventId],
    references: [event.id],
  }),
  machine: one(machine, {
    fields: [delivery.machineId],
    references: [machine.id],
  }),
}));
