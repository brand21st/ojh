"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { Field } from "@/components/affiliates/partner-portal";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { createClient } from "@/lib/supabase/client";

function formValues(form: HTMLFormElement) {
  const data = Object.fromEntries(new FormData(form).entries());
  return {
    email: String(data.email ?? "").trim(),
    password: String(data.password ?? ""),
  };
}

export default function PartnerLoginPage() {
  const router = useRouter();
  const mutation = useMutation({
    mutationFn: async (values: ReturnType<typeof formValues>) => {
      const { error } = await createClient().auth.signInWithPassword({
        email: values.email,
        password: values.password,
      });
      if (error) {
        throw new Error("Unable to sign in. Check your email and password.");
      }
    },
    retry: false,
    onSuccess: () => {
      router.replace("/partner/dashboard");
      router.refresh();
    },
  });
  return (
    <main id="main-content" className="mx-auto w-full max-w-lg p-8">
      <Card className="space-y-5 p-6">
        <h1 className="text-2xl font-semibold">Partner sign in</h1>
        <p className="text-sm text-muted">Use the email and password from partner registration, or any existing PostBus account.</p>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate(formValues(event.currentTarget));
          }}
        >
          <Field name="email" label="Email" type="email" />
          <label className="grid gap-1 text-sm">
            Password
            <Input name="password" type="password" required minLength={8} autoComplete="current-password" />
          </label>
          <Button disabled={mutation.isPending}>{mutation.isPending ? "Signing in…" : "Sign in"}</Button>
        </form>
        {mutation.error ? <p role="alert">{mutation.error.message}</p> : null}
        <p className="text-sm">
          <Link className="underline" href="/forgot-password">
            Reset password
          </Link>
        </p>
        <p className="text-sm">
          <Link className="underline" href="/partner/register">
            Create an account
          </Link>
        </p>
      </Card>
    </main>
  );
}
