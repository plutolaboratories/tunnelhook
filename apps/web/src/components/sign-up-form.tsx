import { useForm } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import z from "zod";

import { authClient } from "@/lib/auth-client";

import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export default function SignUpForm({
  onSwitchToSignIn,
}: {
  onSwitchToSignIn: () => void;
}) {
  const navigate = useNavigate({
    from: "/",
  });

  const form = useForm({
    defaultValues: {
      email: "",
      password: "",
      name: "",
    },
    onSubmit: async ({ value }) => {
      await authClient.signUp.email(
        {
          email: value.email,
          password: value.password,
          name: value.name,
        },
        {
          onSuccess: () => {
            navigate({
              to: "/dashboard",
            });
            toast.success("Account created");
          },
          onError: (error) => {
            toast.error(error.error.message || error.error.statusText);
          },
        }
      );
    },
    validators: {
      onSubmit: z.object({
        name: z.string().min(2, "Name must be at least 2 characters"),
        email: z.email("Invalid email address"),
        password: z.string().min(8, "Password must be at least 8 characters"),
      }),
    },
  });

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
    >
      <form.Field name="name">
        {(field) => (
          <div className="grid gap-1.5">
            <Label htmlFor={field.name}>Name</Label>
            <Input
              id={field.name}
              name={field.name}
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="Your name"
              value={field.state.value}
            />
            {field.state.meta.errors.map((error) => (
              <p className="text-destructive text-xs" key={error?.message}>
                {error?.message}
              </p>
            ))}
          </div>
        )}
      </form.Field>

      <form.Field name="email">
        {(field) => (
          <div className="grid gap-1.5">
            <Label htmlFor={field.name}>Email</Label>
            <Input
              id={field.name}
              name={field.name}
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="you@example.com"
              type="email"
              value={field.state.value}
            />
            {field.state.meta.errors.map((error) => (
              <p className="text-destructive text-xs" key={error?.message}>
                {error?.message}
              </p>
            ))}
          </div>
        )}
      </form.Field>

      <form.Field name="password">
        {(field) => (
          <div className="grid gap-1.5">
            <Label htmlFor={field.name}>Password</Label>
            <Input
              id={field.name}
              name={field.name}
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
              placeholder="At least 8 characters"
              type="password"
              value={field.state.value}
            />
            {field.state.meta.errors.map((error) => (
              <p className="text-destructive text-xs" key={error?.message}>
                {error?.message}
              </p>
            ))}
          </div>
        )}
      </form.Field>

      <form.Subscribe>
        {(state) => (
          <Button
            className="w-full"
            disabled={!state.canSubmit || state.isSubmitting}
            type="submit"
          >
            {state.isSubmitting ? (
              <Loader2
                className="size-4 animate-spin"
                data-icon="inline-start"
              />
            ) : null}
            Create account
          </Button>
        )}
      </form.Subscribe>

      <p className="text-center text-[13px] text-muted-foreground">
        Already have an account?{" "}
        <button
          className="font-medium text-foreground underline underline-offset-4 hover:text-cyan"
          onClick={onSwitchToSignIn}
          type="button"
        >
          Sign in
        </button>
      </p>
    </form>
  );
}
