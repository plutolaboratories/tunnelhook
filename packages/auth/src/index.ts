import { db } from "@tunnelhook/db";
import {
  account,
  session,
  user,
  verification,
} from "@tunnelhook/db/schema/auth";
import { env } from "@tunnelhook/env/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

const authUrl = new URL(env.BETTER_AUTH_URL);
const useSecureCookies = authUrl.protocol === "https:";
const cookieDomain = authUrl.hostname.endsWith("tunnelhook.com")
  ? "tunnelhook.com"
  : undefined;

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "sqlite",

    schema: {
      account,
      session,
      user,
      verification,
    },
  }),
  trustedOrigins: [env.CORS_ORIGIN],
  emailAndPassword: {
    enabled: true,
  },
  session: {
    cookieCache: {
      enabled: false,
    },
  },
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  advanced: {
    defaultCookieAttributes: {
      sameSite: useSecureCookies ? "none" : "lax",
      secure: useSecureCookies,
      httpOnly: true,
    },
    ...(cookieDomain
      ? {
          crossSubDomainCookies: {
            enabled: true,
            domain: cookieDomain,
          },
        }
      : {}),
  },
});
