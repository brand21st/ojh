"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Users } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api } from "@/lib/hooks/use-api";
import { roleLabel } from "@/lib/permissions/rbac";
import { createClient } from "@/lib/supabase/client";
import { cn } from "@/lib/utils";
import type { InviteLookup } from "@/types/team";
import { AUTH_INPUT_CLASS, FormAlert, PasswordInput, SubmitButton } from "../../auth-ui";

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

export function InviteAccept({ token }: { token: string }) {
  const invitePath = `/invite/${encodeURIComponent(token)}`;
  const lookup = useQuery({
    queryKey: ["invite", token],
    queryFn: () => api<InviteLookup>(`/api/v1/auth/invite?token=${encodeURIComponent(token)}`),
    retry: false,
  });
  const session = useQuery({
    queryKey: ["invite-session"],
    queryFn: async () => {
      const { data } = await createClient().auth.getUser();
      return data.user ? { email: data.user.email ?? "" } : null;
    },
  });

  if (lookup.isLoading || session.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Opening your invite…
      </div>
    );
  }

  const invite = lookup.data;
  if (lookup.isError || !invite || invite.status !== "OPEN") {
    const message =
      invite?.status === "EXPIRED"
        ? "This invite has expired. Ask the person who invited you to send a new one."
        : invite?.status === "ACCEPTED"
          ? "This invite was already used. Sign in to open your team's dashboard."
          : invite?.status === "REVOKED"
            ? "This invite was cancelled. Ask for a new one if you still need access."
            : "This invite link isn't valid. Check you copied the whole link.";
    return (
      <div className="space-y-5 text-center">
        <h1 className="text-xl font-semibold">Invite unavailable</h1>
        <p className="text-sm text-muted">{message}</p>
        <Link href="/login" className={cn(buttonVariants(), "h-11 w-full")}>
          Go to sign in
        </Link>
      </div>
    );
  }

  const signedInEmail = session.data?.email?.toLowerCase() ?? null;
  const inviteEmail = invite.email?.toLowerCase() ?? "";

  return (
    <div className="space-y-6">
      <div className="space-y-2 text-center">
        <div className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-brand/10 text-brand">
          <Users className="size-6" aria-hidden />
        </div>
        <h1 className="text-xl font-semibold">Join {invite.organizationName}</h1>
        <p className="text-sm text-muted">
          {invite.invitedByName ? `${invite.invitedByName} invited you` : "You've been invited"} as{" "}
          <span className="font-medium text-foreground">{roleLabel(invite.role)}</span>.
        </p>
      </div>

      {signedInEmail && signedInEmail === inviteEmail ? (
        <AcceptSignedIn token={token} />
      ) : signedInEmail ? (
        <WrongAccount inviteEmail={invite.email ?? ""} signedInEmail={signedInEmail} invitePath={invitePath} />
      ) : invite.hasAccount ? (
        <div className="space-y-4">
          <p className="text-center text-sm text-muted">
            You already have a PostBus login for <span className="font-medium text-foreground">{invite.email}</span>.
            Sign in to join the team.
          </p>
          <Link href={`/login?next=${encodeURIComponent(invitePath)}`} className={cn(buttonVariants(), "h-11 w-full")}>
            Sign in to accept
          </Link>
        </div>
      ) : (
        <CreateLogin token={token} email={invite.email ?? ""} defaultName={invite.fullName ?? ""} invitePath={invitePath} />
      )}
    </div>
  );
}

function AcceptSignedIn({ token }: { token: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setPending(true);
    setError(null);
    try {
      await api("/api/v1/invites/accept", { method: "POST", body: JSON.stringify({ token }) });
      window.location.assign("/dashboard");
    } catch (cause) {
      setError(errorText(cause));
      setPending(false);
    }
  }

  return (
    <div className="space-y-4">
      <FormAlert>{error}</FormAlert>
      <Button type="button" className="h-11 w-full" onClick={accept} disabled={pending}>
        {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {pending ? "Joining…" : "Accept and open dashboard"}
      </Button>
    </div>
  );
}

function WrongAccount({
  inviteEmail,
  signedInEmail,
  invitePath,
}: {
  inviteEmail: string;
  signedInEmail: string;
  invitePath: string;
}) {
  const [pending, setPending] = useState(false);
  async function switchAccount() {
    setPending(true);
    await createClient().auth.signOut();
    window.location.assign(`/login?next=${encodeURIComponent(invitePath)}`);
  }
  return (
    <div className="space-y-4">
      <FormAlert>
        This invite is for <b>{inviteEmail}</b>, but you&apos;re signed in as <b>{signedInEmail}</b>.
      </FormAlert>
      <Button type="button" className="h-11 w-full" onClick={switchAccount} disabled={pending}>
        Sign out and use {inviteEmail}
      </Button>
    </div>
  );
}

function CreateLogin({
  token,
  email,
  defaultName,
  invitePath,
}: {
  token: string;
  email: string;
  defaultName: string;
  invitePath: string;
}) {
  const [fullName, setFullName] = useState(defaultName);
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (fullName.trim().length < 2) return setError("Enter your name.");
    if (password.length < 8) return setError("Use at least 8 characters for your password.");
    setPending(true);
    setError(null);
    try {
      const result = await api<{ signedIn: boolean }>("/api/v1/auth/invite", {
        method: "POST",
        body: JSON.stringify({ token, fullName: fullName.trim(), password }),
      });
      window.location.assign(result.signedIn ? "/dashboard" : "/login");
    } catch (cause) {
      setError(errorText(cause));
      setPending(false);
    }
  }

  return (
    <form className="space-y-4" onSubmit={submit} noValidate>
      <FormAlert>{error}</FormAlert>
      <div className="space-y-1.5">
        <Label htmlFor="invite-email">Email</Label>
        <Input id="invite-email" value={email} readOnly disabled className={AUTH_INPUT_CLASS} />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="invite-name">Your name</Label>
        <Input
          id="invite-name"
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          autoComplete="name"
          className={AUTH_INPUT_CLASS}
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="invite-password">Create a password</Label>
        <PasswordInput
          id="invite-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
          placeholder="At least 8 characters"
        />
      </div>
      <SubmitButton pending={pending} pendingLabel="Setting up your login…">
        Create login and join
      </SubmitButton>
      <p className="text-center text-sm text-muted">
        Already use PostBus?{" "}
        <Link className="font-medium text-brand underline-offset-2 hover:underline" href={`/login?next=${encodeURIComponent(invitePath)}`}>
          Sign in
        </Link>
      </p>
    </form>
  );
}
