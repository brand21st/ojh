"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation } from "@tanstack/react-query";
import { Field } from "@/components/affiliates/partner-portal";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/hooks/use-api";
import { createClient } from "@/lib/supabase/client";

function formValues(form: HTMLFormElement) {
  const data = Object.fromEntries(new FormData(form).entries());
  return {
    name: String(data.name ?? "").trim(),
    email: String(data.email ?? "").trim(),
    password: String(data.password ?? ""),
  };
}

export default function Page() {
  const router = useRouter();
  const mutation = useMutation({
    mutationFn: async (values: ReturnType<typeof formValues>) => {
      await api<{ canSignIn?: boolean }>("/api/partner/register", {
        method: "POST",
        body: JSON.stringify(values),
      });
      const { error } = await createClient().auth.signInWithPassword({
        email: values.email,
        password: values.password,
      });
      if (error) {
        throw new Error("Account created. Sign in with the same email and password.");
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
        <h1 className="text-2xl font-semibold">Join PostBus Partners</h1>
        <p>Create your partner login. You can submit the partner application right after you sign in.</p>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate(formValues(event.currentTarget));
          }}
        >
          <Field name="name" label="Full name" />
          <Field name="email" label="Email" type="email" />
          <label className="grid gap-1 text-sm">
            Password
            <Input name="password" type="password" required minLength={8} maxLength={72} autoComplete="new-password" />
          </label>
          <p className="text-sm text-muted">Use at least 8 characters.</p>
          <Button disabled={mutation.isPending}>{mutation.isPending ? "Creating account…" : "Create account"}</Button>
        </form>
        {mutation.error ? <p role="alert">{mutation.error.message}</p> : null}
        <p className="text-sm">
          <Link className="underline" href="/partner/login">
            Already registered? Sign in
          </Link>
        </p>
        <p className="text-sm">
          <Link className="underline" href="/forgot-password">
            Reset password
          </Link>
        </p>
      </Card>
    </main>
  );
}
