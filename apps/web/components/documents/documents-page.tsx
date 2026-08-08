"use client";

import { Download, FileText, Upload, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { DetailPanel } from "@/components/documents/detail-panel";
import { StatusBadge } from "@/components/documents/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  listDocuments,
  STATUS_LABELS,
  uploadDocument,
  type DocumentListResult,
  type DocumentStatus,
} from "@/lib/documents";
import { formatBytes, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const STATUS_TABS: Array<{ value: DocumentStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  ...(Object.entries(STATUS_LABELS) as Array<[DocumentStatus, string]>).map(([value, label]) => ({
    value,
    label,
  })),
];

const PAGE_SIZE = 20;

interface Kpi {
  label: string;
  count: number;
}

export function DocumentsPage() {
  const router = useRouter();
  const [status, setStatus] = useState<DocumentStatus | "all">("all");
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [ownerId, setOwnerId] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<DocumentListResult | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [listError, setListError] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Filters reset to the first page. Called from the filter handlers so the
  // page state stays in sync without an effect.
  const changeStatus = (next: DocumentStatus | "all"): void => {
    setStatus(next);
    setPage(1);
  };
  const changeOwner = (next: string): void => {
    setOwnerId(next);
    setPage(1);
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQ(q);
      setPage(1);
    }, 300);
    return () => clearTimeout(timer);
  }, [q]);

  useEffect(() => {
    let cancelled = false;
    listDocuments({
      status: status === "all" ? undefined : status,
      q: debouncedQ,
      owner_id: ownerId,
      page,
      page_size: PAGE_SIZE,
    })
      .then(({ status: resStatus, body }) => {
        if (cancelled) return;
        if (resStatus === 401) {
          router.replace("/auth/sign-in");
          return;
        }
        setData(body);
        setListError(null);
      })
      .catch(() => {
        if (!cancelled) setListError("Could not load documents. Try again.");
      });
    return () => {
      cancelled = true;
    };
  }, [status, debouncedQ, ownerId, page, refreshKey, router]);

  const loading = data === null && listError === null;
  const items = useMemo(() => data?.items ?? [], [data]);
  const owners = useMemo(() => {
    const map = new Map<string, string>();
    for (const item of items) map.set(item.owner.id, item.owner.name);
    // Keep the currently selected owner selectable even when the filter hides them.
    const selected = items.find((item) => item.owner.id === ownerId)?.owner;
    if (selected !== undefined) map.set(selected.id, selected.name);
    return Array.from(map, ([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [items, ownerId]);

  // Corpus-wide live counts (the KPI strip reflects the whole corpus, not the page).
  const kpis: Kpi[] = [
    { label: "Documents", count: data?.total ?? 0 },
    { label: "Published", count: data?.counts.published ?? 0 },
    { label: "Parsing", count: data?.counts.publishing ?? 0 },
    { label: "Failed", count: data?.counts.failed ?? 0 },
  ];

  const filtersActive = status !== "all" || debouncedQ !== "" || ownerId !== "";

  const clearFilters = (): void => {
    setStatus("all");
    setQ("");
    setDebouncedQ("");
    setOwnerId("");
    setPage(1);
  };

  const onFileSelected = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setUploadBusy(true);
    setUploadError(null);
    const result = await uploadDocument(file);
    if (result.status === 201) {
      setPage(1);
      setStatus("all");
      setQ("");
      setDebouncedQ("");
      setOwnerId("");
      setDetailId(null);
      // Always refetch — the filters may already be at their defaults, in
      // which case the state resets above are no-ops.
      setRefreshKey((k) => k + 1);
    } else {
      const apiError = result.body.error;
      if (result.status === 413) setUploadError("File is larger than 1 GiB");
      else if (result.status === 400) {
        const fields = apiError?.fields ?? {};
        setUploadError(Object.values(fields).flat()[0] ?? apiError?.message ?? "Unsupported file");
      } else if (result.status === 502) setUploadError("Upload service is unavailable. Try again.");
      else setUploadError(apiError?.message ?? "Upload failed. Try again.");
    }
    setUploadBusy(false);
    if (fileInputRef.current !== null) fileInputRef.current.value = "";
  };

  const detailDocument = detailId !== null ? (items.find((d) => d.id === detailId) ?? null) : null;

  return (
    <>
      <header className="flex items-center justify-between gap-4 border-b px-6 py-4">
        <div>
          <h1 className="text-lg font-semibold">Documents</h1>
          <p className="text-sm text-muted-foreground">Upload, review, and publish knowledge documents</p>
        </div>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            aria-label="Upload a document"
            onChange={(e) => void onFileSelected(e.target.files?.[0])}
          />
          <Button onClick={() => fileInputRef.current?.click()} disabled={uploadBusy}>
            <Upload aria-hidden />
            {uploadBusy ? "Uploading…" : "Upload"}
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          {(uploadError !== null || listError !== null) && (
            <p role="alert" className="border-b px-6 py-2 text-sm text-destructive">
              {uploadError ?? listError}
            </p>
          )}

          {/* KPI strip */}
          <div className="grid grid-cols-4 gap-px border-b bg-border">
            {kpis.map((kpi) => (
              <div key={kpi.label} className="bg-background px-6 py-3">
                <p className="text-2xl font-semibold tabular-nums">{kpi.count}</p>
                <p className="text-xs text-muted-foreground">{kpi.label}</p>
              </div>
            ))}
          </div>

          {/* Filter bar */}
          <div className="flex flex-wrap items-center gap-3 border-b px-6 py-3">
            <div role="tablist" aria-label="Filter by status" className="flex items-center gap-1">
              {STATUS_TABS.map((tab) => (
                <button
                  key={tab.value}
                  role="tab"
                  aria-selected={status === tab.value}
                  onClick={() => changeStatus(tab.value)}
                  className={cn(
                    "rounded-lg px-2.5 py-1 text-sm font-medium transition-colors",
                    status === tab.value
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <Input
              type="search"
              placeholder="Search by name…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="w-56"
              aria-label="Search documents by name"
            />
            <select
              value={ownerId}
              onChange={(e) => changeOwner(e.target.value)}
              className="h-8 rounded-lg border border-input bg-transparent px-2 text-sm outline-none focus-visible:border-ring"
              aria-label="Filter by owner"
            >
              <option value="">All owners</option>
              {owners.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.name}
                </option>
              ))}
            </select>
            <p className="ml-auto text-sm text-muted-foreground">
              Showing {items.length} of {data?.total ?? 0}
            </p>
            {filtersActive && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                <X aria-hidden />
                Clear filters
              </Button>
            )}
          </div>

          {/* Table */}
          {loading ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <p className="text-sm text-muted-foreground">Loading documents…</p>
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <div className="flex max-w-sm flex-col items-center gap-3 text-center">
                <div className="flex size-10 items-center justify-center rounded-full bg-muted">
                  <FileText className="size-5 text-muted-foreground" aria-hidden />
                </div>
                {filtersActive ? (
                  <>
                    <h2 className="text-base font-semibold">No documents match your filters</h2>
                    <p className="text-sm text-muted-foreground">Try widening the search or clearing the filters.</p>
                    <Button variant="outline" size="sm" onClick={clearFilters}>
                      Clear filters
                    </Button>
                  </>
                ) : (
                  <>
                    <h2 className="text-base font-semibold">No documents yet</h2>
                    <p className="text-sm text-muted-foreground">Upload a file to create your first draft document.</p>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="px-6 py-2 font-medium">Name</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Owner</th>
                    <th className="px-4 py-2 font-medium">Size</th>
                    <th className="px-4 py-2 font-medium">Updated</th>
                    <th className="px-4 py-2" aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((document) => (
                    <tr
                      key={document.id}
                      onClick={() => setDetailId(document.id)}
                      className="cursor-pointer border-b transition-colors hover:bg-muted/50 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
                    >
                      <td className="max-w-72 truncate px-6 py-2.5 font-medium" title={document.name}>
                        {document.name}
                      </td>
                      <td className="px-4 py-2.5">
                        <StatusBadge status={document.status} progress={document.progress} />
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">{document.owner.name}</td>
                      <td className="px-4 py-2.5 tabular-nums text-muted-foreground">{formatBytes(document.size_bytes)}</td>
                      <td className="px-4 py-2.5 text-muted-foreground">{formatDate(document.updated_at)}</td>
                      <td className="px-4 py-2.5 text-right">
                        <a
                          href={`/api/documents/${document.id}/download`}
                          aria-label={`Download ${document.name}`}
                          title="Download"
                          className="inline-flex size-7 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Download className="size-4" aria-hidden />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data !== null && data.total > PAGE_SIZE && (
                <div className="flex items-center justify-end gap-3 px-6 py-3">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </Button>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    Page {data.page} of {Math.max(1, Math.ceil(data.total / data.page_size))}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= Math.ceil(data.total / data.page_size)}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>

        {detailDocument !== null && (
          <DetailPanel document={detailDocument} onCloseAction={() => setDetailId(null)} />
        )}
      </div>
    </>
  );
}
