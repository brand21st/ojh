"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, Download, Mail, PackagePlus } from "lucide-react";
import { toast } from "sonner";
import { DataTable, type DataTableColumn } from "@/components/dashboard/data-table";
import { ManifestListMailButton } from "@/components/dashboard/manifest-list-mail-button";
import { PageHeader } from "@/components/dashboard/page-header";
import { StatusBadge } from "@/components/dashboard/status-badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MANIFEST_STATUS_LABEL, manifestOfficeLabel } from "@/lib/dashboard/manifests";
import { formatDate } from "@/lib/format";
import { api } from "@/lib/hooks/use-api";
import { useMe } from "@/lib/hooks/use-me";
import { hasPermission } from "@/lib/permissions/rbac";
import { cn } from "@/lib/utils";
import type { MemberRole } from "@/types/domain";
import type { ManifestListResponse, ManifestRecord } from "@/types/api";

const TABS = [
  { id: "", label: "All" },
  { id: "DRAFT", label: "Drafts" },
  { id: "CLOSED", label: "Closed" },
  { id: "HANDED_OVER", label: "Handed over" },
] as const;

export default function ManifestsPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const me = useMe();
  const canWrite = hasPermission((me.data?.role ?? "VIEWER") as MemberRole, "manifests.write");
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<string>("");

  const query = useQuery({
    queryKey: ["manifests", page, status],
    queryFn: () =>
      api<ManifestListResponse>(`/api/v1/manifests?page=${page}&pageSize=20${status ? `&status=${status}` : ""}`),
    refetchInterval: 15_000,
  });

  const sweep = useMutation({
    mutationFn: () => api<{ added: number; manifestIds: string[] }>("/api/v1/manifests", { method: "POST" }),
    onSuccess: (result) => {
      toast.success(
        result.added
          ? `${result.added} shipment${result.added === 1 ? "" : "s"} added to today's draft manifest.`
          : "No labelled shipments are waiting for a manifest."
      );
      queryClient.invalidateQueries({ queryKey: ["manifests"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const filterBy = (next: string) => {
    setStatus(next);
    setPage(1);
  };

  const summary = query.data?.summary;
  const cards: Array<{
    label: string;
    value: number | undefined;
    hint: string;
    filter?: string;
    warn?: boolean;
  }> = [
    {
      label: "Open drafts",
      value: summary?.openDrafts,
      hint: "Review and close before pickup.",
      filter: "DRAFT",
    },
    {
      label: "Waiting for a manifest",
      value: summary?.awaitingManifest,
      hint: "Labelled shipments not on any manifest.",
    },
    {
      label: "Not scanned by India Post",
      value: summary?.unscannedAfterHandover,
      hint: "Handed over 24+ hours ago with no India Post scan.",
      warn: Boolean(summary?.unscannedAfterHandover),
      filter: "HANDED_OVER",
    },
  ];

  const items = query.data?.items ?? [];
  // Legacy manifests have no office; only show the column when real offices differ.
  const showOffice = useMemo(() => {
    const offices = new Set(items.map((row) => row.officeId ?? row.officeName).filter(Boolean));
    return offices.size > 1;
  }, [items]);

  const columns = useMemo<DataTableColumn<ManifestRecord>[]>(() => {
    const cols: DataTableColumn<ManifestRecord>[] = [
      {
        id: "number",
        header: "Manifest",
        cell: (row) => (
          <Link
            href={`/dashboard/manifests/${row.id}`}
            aria-label={manifestLinkLabel(row)}
            className="whitespace-nowrap font-medium text-brand hover:underline"
          >
            {row.number ?? "Draft"}
          </Link>
        ),
      },
      {
        id: "date",
        header: "Date",
        cell: (row) => <span className="whitespace-nowrap">{formatDate(row.date)}</span>,
        fill: !showOffice,
      },
    ];
    if (showOffice) {
      cols.push({
        id: "office",
        header: "Booking office",
        cell: (row) => manifestOfficeLabel(row),
        fill: true,
      });
    }
    cols.push(
      {
        id: "count",
        header: "Shipments",
        cell: (row) => <span className="tabular-nums">{row.shipmentCount}</span>,
      },
      {
        id: "status",
        header: "Status",
        cell: (row) => (
          <ManifestStatus row={row} />
        ),
      },
      {
        id: "actions",
        header: "Actions",
        hug: true,
        width: 168,
        cell: (row) => <ManifestRowActions row={row} canWrite={canWrite} />,
      }
    );
    return cols;
  }, [canWrite, showOffice]);

  const emptyCopy = EMPTY_COPY[status] ?? EMPTY_COPY[""];

  const mobileList = (
    <ul className="divide-y divide-border">
      {items.map((row) => (
        <li key={row.id} className="flex items-start justify-between gap-3 px-4 py-3">
          <div className="min-w-0 space-y-1">
            <Link
              href={`/dashboard/manifests/${row.id}`}
              aria-label={manifestLinkLabel(row)}
              className="block truncate font-medium text-brand hover:underline"
            >
              {row.number ?? "Draft"}
            </Link>
            <p className="text-xs text-muted">
              {formatDate(row.date)} · {row.shipmentCount} shipment{row.shipmentCount === 1 ? "" : "s"}
              {showOffice ? ` · ${manifestOfficeLabel(row)}` : ""}
            </p>
            <ManifestStatus row={row} />
          </div>
          <div className="w-32 shrink-0">
            <ManifestRowActions row={row} canWrite={canWrite} />
          </div>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Manifests"
        description="Close drafts before pickup, then mark them handed over."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/dashboard/manifests/settings" className={buttonVariants({ variant: "secondary" })}>
              <Mail className="size-4" />
              Email settings
            </Link>
            {canWrite ? (
              <Button type="button" onClick={() => sweep.mutate()} disabled={sweep.isPending}>
                <PackagePlus className="size-4" />
                Add ready shipments
              </Button>
            ) : null}
          </div>
        }
      />

      <section className="grid grid-cols-3 gap-2 sm:gap-4">
        {cards.map((card) => {
          const active = Boolean(card.filter) && status === card.filter;
          const select = card.filter ? () => filterBy(active ? "" : card.filter!) : undefined;
          return (
            <Card
              key={card.label}
              role={select ? "button" : undefined}
              tabIndex={select ? 0 : undefined}
              aria-pressed={select ? active : undefined}
              title={select ? (active ? "Show all manifests" : `Show ${MANIFEST_STATUS_LABEL[card.filter!]?.toLowerCase()} manifests`) : undefined}
              className={cn(
                select &&
                  "cursor-pointer transition-shadow duration-150 hover:ring-1 hover:ring-brand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand",
                card.warn && "ring-1 ring-amber-300",
                active && "ring-2 ring-brand hover:ring-brand"
              )}
              onClick={select}
              onKeyDown={(event) => {
                if (select && (event.key === "Enter" || event.key === " ")) {
                  event.preventDefault();
                  select();
                }
              }}
            >
              <CardHeader className="gap-1 p-3 sm:gap-1.5 sm:p-6">
                <CardDescription className="text-xs sm:text-sm">{card.label}</CardDescription>
                <CardTitle className="text-2xl tabular-nums sm:text-3xl">
                  {query.isLoading ? "…" : query.isError ? "—" : card.value ?? 0}
                </CardTitle>
                <CardDescription className="hidden sm:block">{card.hint}</CardDescription>
              </CardHeader>
            </Card>
          );
        })}
      </section>

      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Manifest status">
        {TABS.map((tab) => (
          <Button
            key={tab.id || "all"}
            type="button"
            role="tab"
            aria-selected={status === tab.id}
            variant={status === tab.id ? "primary" : "secondary"}
            size="sm"
            onClick={() => filterBy(tab.id)}
          >
            {tab.label}
          </Button>
        ))}
      </div>

      <DataTable
        columns={columns}
        data={items}
        loading={query.isLoading}
        error={query.error instanceof Error ? query.error : null}
        emptyTitle={emptyCopy.title}
        emptyDescription={emptyCopy.description}
        emptyAction={
          status === "" || status === "DRAFT" ? (
            <div className="flex items-center gap-2 text-muted">
              <ClipboardList className="size-4" aria-hidden="true" />
              Waiting for labelled shipments.
            </div>
          ) : undefined
        }
        mobileView={mobileList}
        page={query.data?.page ?? page}
        pageSize={query.data?.pageSize ?? 20}
        total={query.data?.total ?? 0}
        onPageChange={setPage}
        getRowId={(row) => row.id}
        onRowClick={(row) => router.push(`/dashboard/manifests/${row.id}`)}
      />
    </div>
  );
}

const EMPTY_COPY: Record<string, { title: string; description: string }> = {
  "": {
    title: "No manifests yet",
    description: "When India Post books and labels a shipment, it joins today's draft manifest automatically.",
  },
  DRAFT: {
    title: "No draft manifests",
    description: "New labelled shipments start a draft for their booking office automatically.",
  },
  CLOSED: {
    title: "No closed manifests",
    description: "Close a draft before pickup and it moves here, ready to hand over.",
  },
  HANDED_OVER: {
    title: "No handed over manifests",
    description: "Mark a closed manifest as handed over after pickup and it shows here.",
  },
};

function manifestLinkLabel(row: ManifestRecord) {
  return row.number
    ? `Open manifest ${row.number}`
    : `Open draft manifest for ${formatDate(row.date)}`;
}

function ManifestStatus({ row }: { row: ManifestRecord }) {
  return (
    <div className="space-y-0.5 whitespace-nowrap">
      <StatusBadge value={row.status} />
      {row.handedOverAt ? (
        <p className="text-xs text-muted">
          {formatDate(row.handedOverAt, true)}
          {row.handedOverTo ? ` · ${row.handedOverTo}` : ""}
        </p>
      ) : null}
    </div>
  );
}

function ManifestRowActions({ row, canWrite }: { row: ManifestRecord; canWrite: boolean }) {
  return (
    <div className="flex flex-col items-stretch gap-1.5">
      <a
        href={`/api/v1/manifests/${row.id}/export?format=xlsx`}
        aria-label={`Download handover list for ${row.number ?? `draft ${formatDate(row.date)}`}`}
        className="inline-flex min-h-8 items-center justify-center gap-1 text-sm font-medium text-brand hover:underline"
        onClick={(event) => event.stopPropagation()}
      >
        <Download className="size-3.5" aria-hidden="true" />
        Handover
      </a>
      <ManifestListMailButton row={row} canSend={canWrite} />
    </div>
  );
}
