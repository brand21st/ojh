"use client";

import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { switchState, toggleSwitch, type Overrides } from "@/lib/permissions/feature-toggle";
import {
  FEATURE_GROUPS,
  MEMBER_TEAMS,
  ROLE_DETAILS,
  TEAM_DEFAULT_ROLE,
  TEAM_LABELS,
  canAssignRole,
  normalizeOverrides,
  type MemberTeam,
} from "@/lib/permissions/rbac";
import { cn } from "@/lib/utils";
import type { MemberRole } from "@/types/domain";

export type AccessValue = {
  role: MemberRole;
  team: MemberTeam | null;
  title: string;
  overrides: Overrides;
};

const NO_TEAM = "__none";

export function MemberAccessEditor({
  value,
  onChange,
  actorRole,
  lockRole = false,
}: {
  value: AccessValue;
  onChange: (next: AccessValue) => void;
  actorRole: MemberRole;
  lockRole?: boolean;
}) {
  const roles = ROLE_DETAILS.filter((item) => item.role === value.role || canAssignRole(actorRole, item.role));
  const roleInfo = ROLE_DETAILS.find((item) => item.role === value.role);

  function setRole(role: MemberRole) {
    // Overrides are relative to a role, so keep only the ones that still make sense.
    onChange({ ...value, role, overrides: normalizeOverrides(role, value.overrides) as Overrides });
  }

  function setTeam(raw: string) {
    const team = raw === NO_TEAM ? null : (raw as MemberTeam);
    // Picking a team suggests its usual role, if the actor may give it and the role isn't locked.
    const suggested = team ? TEAM_DEFAULT_ROLE[team] : null;
    if (!lockRole && suggested && canAssignRole(actorRole, suggested) && value.role !== "OWNER") {
      onChange({ ...value, team, role: suggested, overrides: { extra: [], revoked: [] } });
      return;
    }
    onChange({ ...value, team });
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Team</Label>
          <Select value={value.team ?? NO_TEAM} onValueChange={setTeam}>
            <SelectTrigger>
              <SelectValue placeholder="No team" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_TEAM}>No team</SelectItem>
              {MEMBER_TEAMS.map((team) => (
                <SelectItem key={team} value={team}>
                  {TEAM_LABELS[team]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Role</Label>
          <Select value={value.role} onValueChange={(role) => setRole(role as MemberRole)} disabled={lockRole}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {roles.map((item) => (
                <SelectItem key={item.role} value={item.role}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="member-title">Job title (optional)</Label>
          <Input
            id="member-title"
            value={value.title}
            maxLength={80}
            placeholder="e.g. Warehouse lead, Night shift packer"
            onChange={(event) => onChange({ ...value, title: event.target.value })}
          />
        </div>
      </div>
      {roleInfo ? <p className="text-sm text-muted">{roleInfo.description}</p> : null}

      <div className="space-y-2">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Features</p>
            <p className="text-xs text-muted">Switch off anything this person doesn&apos;t need.</p>
          </div>
          <div className="hidden w-[7.5rem] grid-cols-2 text-center text-xs font-medium text-muted sm:grid">
            <span>View</span>
            <span>Edit</span>
          </div>
        </div>
        <ul className="divide-y divide-border rounded-xl border border-border">
          {FEATURE_GROUPS.map((group) => {
            const view = switchState(value.role, value.overrides, group, "view");
            const edit = switchState(value.role, value.overrides, group, "edit");
            const anyOn = Boolean(view?.on || edit?.on);
            return (
              <li key={group.key} className="flex items-center gap-3 px-3 py-2.5">
                <div className={cn("min-w-0 flex-1", !anyOn && "opacity-60")}>
                  <p className="text-sm font-medium">{group.label}</p>
                  <p className="truncate text-xs text-muted">{group.description}</p>
                </div>
                <div className="grid w-[7.5rem] shrink-0 grid-cols-2 place-items-center">
                  {[
                    { level: "view" as const, state: view },
                    { level: "edit" as const, state: edit },
                  ].map(({ level, state }) =>
                    state ? (
                      <span key={level} title={state.reason ?? (level === "view" ? "View" : "Edit")}>
                        <Switch
                          aria-label={`${group.label}: ${level}`}
                          checked={state.on}
                          disabled={!state.available}
                          onCheckedChange={(on) =>
                            onChange({
                              ...value,
                              overrides: toggleSwitch(value.role, value.overrides, group, level, on),
                            })
                          }
                        />
                      </span>
                    ) : (
                      <span key={level} aria-hidden className="text-xs text-muted/50">
                        –
                      </span>
                    )
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-muted">
          Greyed-out switches need a higher role. Billing, team management and API keys always follow the role.
        </p>
      </div>
    </div>
  );
}
