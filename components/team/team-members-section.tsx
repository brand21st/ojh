"use client";

import { useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  BarChart3,
  Check,
  Copy,
  Mail,
  MoreHorizontal,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  Trash2,
  UserPlus,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { MemberAccessEditor, type AccessValue } from "@/components/team/member-access-editor";
import { featureSummary } from "@/lib/permissions/feature-toggle";
import { FEATURE_GROUPS, TEAM_LABELS, roleLabel, type MemberTeam } from "@/lib/permissions/rbac";
import { meCan } from "@/lib/permissions/me";
import { api } from "@/lib/hooks/use-api";
import { useMe } from "@/lib/hooks/use-me";
import { formatDate, formatRelative, initials } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { MemberRole } from "@/types/domain";
import type { CreatedInvite, TeamInvite, TeamMember } from "@/types/team";

const ROLE_BADGE: Record<string, "brand" | "success" | "warning" | "default" | "outline"> = {
  OWNER: "brand",
  ADMIN: "brand",
  MANAGER: "success",
  OPERATOR: "default",
  PACKER: "warning",
  VIEWER: "outline",
};

function nameOf(member: { fullName: string | null; email: string | null }) {
  return member.fullName?.trim() || member.email?.split("@")[0] || "Member";
}

function blankAccess(): AccessValue {
  return { role: "OPERATOR", team: "FULFILLMENT", title: "", overrides: { extra: [], revoked: [] } };
}

export function TeamMembersSection() {
  const queryClient = useQueryClient();
  const me = useMe();
  const actorRole = (me.data?.role ?? "VIEWER") as MemberRole;
  const canManage = meCan(me.data, "members.manage");
  const canSeeStats = meCan(me.data, "team.read");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [editing, setEditing] = useState<TeamMember | null>(null);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const [shareLink, setShareLink] = useState<CreatedInvite | null>(null);

  const members = useQuery({
    queryKey: ["team-members"],
    queryFn: () => api<{ items: TeamMember[] }>("/api/v1/members"),
  });
  const invites = useQuery({
    queryKey: ["team-invites"],
    queryFn: () => api<{ items: TeamInvite[] }>("/api/v1/members/invites"),
    enabled: canManage,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["team-members"] });
    queryClient.invalidateQueries({ queryKey: ["team-invites"] });
  };

  const setStatus = useMutation({
    mutationFn: (input: { id: string; status: "ACTIVE" | "SUSPENDED" }) =>
      api(`/api/v1/members/${input.id}`, { method: "PATCH", body: JSON.stringify({ status: input.status }) }),
    onSuccess: (_data, input) => {
      toast.success(input.status === "SUSPENDED" ? "Access paused." : "Access turned back on.");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/members/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Removed from the team.");
      setRemoving(null);
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const resend = useMutation({
    mutationFn: (id: string) => api<CreatedInvite>(`/api/v1/members/invites/${id}/resend`, { method: "POST" }),
    onSuccess: (invite) => {
      setShareLink(invite);
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/v1/members/invites/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast.success("Invite cancelled.");
      refresh();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const rows = members.data?.items ?? [];
  const inviteRows = invites.data?.items ?? [];
  const active = rows.filter((row) => row.status === "ACTIVE").length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Team members</CardTitle>
            <CardDescription>
              {members.isLoading
                ? "Loading your team…"
                : `${active} active ${active === 1 ? "member" : "members"}. Each person signs in with their own login.`}
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            {canSeeStats ? (
              <Link href="/dashboard/team" className={cn(buttonVariants({ variant: "secondary" }), "gap-2")}>
                <BarChart3 className="size-4" aria-hidden /> Performance
              </Link>
            ) : null}
            {canManage ? (
              <Button type="button" className="gap-2" onClick={() => setInviteOpen(true)}>
                <UserPlus className="size-4" aria-hidden /> Add member
              </Button>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {members.isLoading ? (
            <div className="space-y-2 p-4">
              {[0, 1, 2].map((key) => (
                <Skeleton key={key} className="h-14 w-full" />
              ))}
            </div>
          ) : members.isError ? (
            <p className="p-6 text-sm text-error">{(members.error as Error).message}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-y border-border bg-surface-soft/60 text-left text-xs font-medium uppercase tracking-wide text-muted">
                    <th className="px-4 py-2.5">Member</th>
                    <th className="px-3 py-2.5">Role & team</th>
                    <th className="px-3 py-2.5 text-center" title="Booked · Packed · Labels printed, today">
                      Today
                    </th>
                    <th className="px-3 py-2.5">Last active</th>
                    <th className="px-3 py-2.5">Access</th>
                    <th className="w-12 px-3 py-2.5" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {rows.map((member) => {
                    const summary = featureSummary(
                      member.role,
                      { extra: member.extraPermissions, revoked: member.revokedPermissions },
                      FEATURE_GROUPS
                    );
                    const customised = member.extraPermissions.length + member.revokedPermissions.length > 0;
                    return (
                      <tr key={member.id} className={cn(member.status === "SUSPENDED" && "bg-surface-soft/40 text-muted")}>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand/10 text-xs font-semibold text-brand-dark">
                              {initials(nameOf(member), "M")}
                            </span>
                            <div className="min-w-0">
                              <p className="truncate font-medium text-foreground">
                                {nameOf(member)}
                                {member.isYou ? <span className="ml-1.5 text-xs font-normal text-muted">(you)</span> : null}
                              </p>
                              <p className="truncate text-xs text-muted">
                                {member.title ? `${member.title} · ` : ""}
                                {member.email}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant={ROLE_BADGE[member.role] ?? "default"}>{roleLabel(member.role)}</Badge>
                            {member.team ? (
                              <span className="text-xs text-muted">{TEAM_LABELS[member.team as MemberTeam] ?? member.team}</span>
                            ) : null}
                          </div>
                          {customised ? (
                            <p className="mt-1 text-xs text-muted">
                              Custom access · {summary.on} of {summary.total} features
                            </p>
                          ) : null}
                        </td>
                        <td className="px-3 py-3 text-center tabular-nums">
                          <span title="Booked">{member.today["order.booked"]}</span>
                          <span className="px-1 text-muted/60">·</span>
                          <span title="Packed">{member.today["order.packed"]}</span>
                          <span className="px-1 text-muted/60">·</span>
                          <span title="Labels printed">{member.today["label.printed"]}</span>
                        </td>
                        <td className="px-3 py-3 text-xs text-muted">
                          {member.lastActiveAt ? formatRelative(member.lastActiveAt) : `Joined ${formatDate(member.joinedAt)}`}
                        </td>
                        <td className="px-3 py-3">
                          {member.status === "SUSPENDED" ? (
                            <Badge variant="warning">Paused</Badge>
                          ) : (
                            <Badge variant="success">Active</Badge>
                          )}
                        </td>
                        <td className="px-3 py-3 text-right">
                          {canManage && member.canManage ? (
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <Button type="button" variant="ghost" size="icon" aria-label={`Actions for ${nameOf(member)}`}>
                                  <MoreHorizontal className="size-4" />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={() => setEditing(member)}>Edit role & features</DropdownMenuItem>
                                {member.status === "ACTIVE" ? (
                                  <DropdownMenuItem onSelect={() => setStatus.mutate({ id: member.id, status: "SUSPENDED" })}>
                                    <PauseCircle className="mr-2 size-4" /> Pause access
                                  </DropdownMenuItem>
                                ) : (
                                  <DropdownMenuItem onSelect={() => setStatus.mutate({ id: member.id, status: "ACTIVE" })}>
                                    <PlayCircle className="mr-2 size-4" /> Turn access back on
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuSeparator />
                                <DropdownMenuItem className="text-error" onSelect={() => setRemoving(member)}>
                                  <Trash2 className="mr-2 size-4" /> Remove from team
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {canManage ? (
        <Card>
          <CardHeader>
            <CardTitle>Pending invites</CardTitle>
            <CardDescription>Invites work for 7 days. Resend to get a fresh link you can share on WhatsApp.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {inviteRows.length === 0 ? (
              <p className="text-sm text-muted">No pending invites.</p>
            ) : (
              inviteRows.map((invite) => (
                <div
                  key={invite.id}
                  className="flex flex-col gap-2 rounded-xl border border-border px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {invite.fullName ? `${invite.fullName} · ` : ""}
                      {invite.email}
                    </p>
                    <p className="text-xs text-muted">
                      {roleLabel(invite.role)}
                      {invite.team ? ` · ${TEAM_LABELS[invite.team as MemberTeam] ?? invite.team}` : ""} ·{" "}
                      {invite.expired ? (
                        <span className="text-warning">Expired</span>
                      ) : (
                        `Expires ${formatDate(invite.expiresAt)}`
                      )}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      className="gap-1.5"
                      disabled={resend.isPending}
                      onClick={() => resend.mutate(invite.id)}
                    >
                      <RefreshCw className="size-3.5" aria-hidden /> Resend
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="gap-1.5 text-error"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate(invite.id)}
                    >
                      <X className="size-3.5" aria-hidden /> Cancel
                    </Button>
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      ) : null}

      {inviteOpen ? (
        <InviteDialog
          actorRole={actorRole}
          onClose={() => setInviteOpen(false)}
          onCreated={(invite) => {
            setInviteOpen(false);
            setShareLink(invite);
            refresh();
          }}
        />
      ) : null}
      {editing ? (
        <EditMemberDialog
          member={editing}
          actorRole={actorRole}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refresh();
          }}
        />
      ) : null}
      {shareLink ? <ShareInviteDialog invite={shareLink} onClose={() => setShareLink(null)} /> : null}

      <Dialog open={Boolean(removing)} onOpenChange={(open) => (!open ? setRemoving(null) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {removing ? nameOf(removing) : ""}?</DialogTitle>
            <DialogDescription>
              They lose access straight away. Their past work stays in team reports. To stop access for a while instead,
              use Pause access.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setRemoving(null)}>
              Keep
            </Button>
            <Button
              type="button"
              className="bg-error text-white hover:bg-error/90"
              disabled={remove.isPending}
              onClick={() => removing && remove.mutate(removing.id)}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function InviteDialog({
  actorRole,
  onClose,
  onCreated,
}: {
  actorRole: MemberRole;
  onClose: () => void;
  onCreated: (invite: CreatedInvite) => void;
}) {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [access, setAccess] = useState<AccessValue>(blankAccess);

  const create = useMutation({
    mutationFn: () =>
      api<CreatedInvite>("/api/v1/members/invites", {
        method: "POST",
        body: JSON.stringify({
          email,
          fullName: fullName || null,
          role: access.role,
          team: access.team,
          title: access.title || null,
          extraPermissions: access.overrides.extra,
          revokedPermissions: access.overrides.revoked,
        }),
      }),
    onSuccess: onCreated,
    onError: (error: Error) => toast.error(error.message),
  });

  const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a team member</DialogTitle>
          <DialogDescription>
            They get an invite to create their own PostBus login. You&apos;ll also get a link to share on WhatsApp.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            if (validEmail) create.mutate();
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="invite-name">Name</Label>
              <Input
                id="invite-name"
                value={fullName}
                maxLength={120}
                placeholder="Ravi Kumar"
                onChange={(event) => setFullName(event.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                placeholder="ravi@yourstore.in"
                onChange={(event) => setEmail(event.target.value)}
                required
              />
            </div>
          </div>
          <MemberAccessEditor value={access} onChange={setAccess} actorRole={actorRole} />
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" className="gap-2" disabled={!validEmail || create.isPending}>
              <Mail className="size-4" aria-hidden /> {create.isPending ? "Sending…" : "Send invite"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditMemberDialog({
  member,
  actorRole,
  onClose,
  onSaved,
}: {
  member: TeamMember;
  actorRole: MemberRole;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [access, setAccess] = useState<AccessValue>({
    role: member.role,
    team: (member.team as MemberTeam | null) ?? null,
    title: member.title ?? "",
    overrides: { extra: member.extraPermissions, revoked: member.revokedPermissions },
  });

  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/members/${member.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          role: access.role,
          team: access.team,
          title: access.title || null,
          extraPermissions: access.overrides.extra,
          revokedPermissions: access.overrides.revoked,
        }),
      }),
    onSuccess: () => {
      toast.success("Access updated. It applies on their next page load.");
      onSaved();
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{nameOf(member)}</DialogTitle>
          <DialogDescription>{member.email}</DialogDescription>
        </DialogHeader>
        <MemberAccessEditor value={access} onChange={setAccess} actorRole={actorRole} />
        <DialogFooter>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShareInviteDialog({ invite, onClose }: { invite: CreatedInvite; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const message = `You're invited to join our team on PostBus as ${roleLabel(invite.role)}. Set up your login here: ${invite.inviteUrl}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(invite.inviteUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy. Select the link and copy it.");
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite ready</DialogTitle>
          <DialogDescription>
            {invite.emailSent
              ? `We emailed ${invite.email}. You can also share this link with them directly.`
              : `Share this link with ${invite.email} to finish. Email isn't set up for invites yet.`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input readOnly value={invite.inviteUrl} onFocus={(event) => event.currentTarget.select()} aria-label="Invite link" />
          <Button type="button" variant="secondary" className="shrink-0 gap-1.5" onClick={copy}>
            {copied ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
        <p className="text-xs text-muted">Only shown now. If you lose it, use Resend to make a new one.</p>
        <DialogFooter>
          <a
            href={`https://wa.me/?text=${encodeURIComponent(message)}`}
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: "secondary" }))}
          >
            Share on WhatsApp
          </a>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
