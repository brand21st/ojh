"use client";

import { Check, Eye, Minus } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FEATURE_GROUPS, ROLE_DETAILS, permissionsFor } from "@/lib/permissions/rbac";

/** What each role includes, feature by feature. Per-member switches can narrow it further. */
export function RolesOverview() {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Roles</CardTitle>
          <CardDescription>
            A role sets what someone can do at most. When you add or edit a member you can switch off features they
            don&apos;t need, or add view-only access, the packing station and team performance.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {ROLE_DETAILS.map((item) => (
            <div key={item.role} className="rounded-xl border border-border p-3">
              <p className="text-sm font-semibold">{item.label}</p>
              <p className="mt-1 text-sm text-muted">{item.description}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What each role can do</CardTitle>
          <CardDescription>
            <Check className="mr-1 inline size-3.5 text-success" aria-hidden />
            can edit ·
            <Eye className="mx-1 inline size-3.5 text-muted" aria-hidden />
            view only ·
            <Minus className="mx-1 inline size-3.5 text-muted/60" aria-hidden />
            no access
          </CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-y border-border bg-surface-soft/60 text-xs font-medium uppercase tracking-wide text-muted">
                <th className="px-4 py-2.5 text-left">Feature</th>
                {ROLE_DETAILS.map((item) => (
                  <th key={item.role} className="px-2 py-2.5 text-center">
                    {item.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {FEATURE_GROUPS.map((group) => (
                <tr key={group.key}>
                  <td className="px-4 py-2.5 font-medium">{group.label}</td>
                  {ROLE_DETAILS.map((item) => {
                    const permissions = permissionsFor(item.role);
                    const edit = group.edit.length > 0 && group.edit.some((permission) => permissions.includes(permission));
                    const view = group.view.length > 0 && group.view.every((permission) => permissions.includes(permission));
                    return (
                      <td key={item.role} className="px-2 py-2.5 text-center">
                        {edit ? (
                          <Check className="mx-auto size-4 text-success" aria-label="Can edit" />
                        ) : view ? (
                          <Eye className="mx-auto size-4 text-muted" aria-label="View only" />
                        ) : (
                          <Minus className="mx-auto size-4 text-muted/50" aria-label="No access" />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
