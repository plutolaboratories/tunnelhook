import { createFileRoute } from "@tanstack/react-router";
import { Webhook } from "lucide-react";
import { useState } from "react";

import SignInForm from "@/components/sign-in-form";
import SignUpForm from "@/components/sign-up-form";

export const Route = createFileRoute("/login")({
  component: LoginPage,
});

function LoginPage() {
  const [showSignIn, setShowSignIn] = useState(false);

  return (
    <div className="flex h-svh items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-2">
          <div className="flex size-10 items-center justify-center rounded-[14px] bg-cyan-subtle">
            <Webhook className="size-5 text-cyan" />
          </div>
          <h1 className="font-semibold text-[18px] tracking-tight">
            {showSignIn ? "Welcome back" : "Create your account"}
          </h1>
          <p className="text-[13px] text-muted-foreground">
            {showSignIn
              ? "Sign in to your tunnelhook account"
              : "Get started with tunnelhook"}
          </p>
        </div>
        <div className="rounded-[14px] bg-card p-5 shadow-[0_1px_2px_rgba(0,0,0,.06)] ring-1 ring-border">
          {showSignIn ? (
            <SignInForm onSwitchToSignUp={() => setShowSignIn(false)} />
          ) : (
            <SignUpForm onSwitchToSignIn={() => setShowSignIn(true)} />
          )}
        </div>
      </div>
    </div>
  );
}
