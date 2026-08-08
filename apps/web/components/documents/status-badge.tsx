import { Badge } from "@/components/ui/badge";
import { STATUS_LABELS, type DocumentStatus } from "@/lib/documents";
import { cn } from "@/lib/utils";

const STATUS_VARIANTS: Record<DocumentStatus, "default" | "secondary" | "outline" | "destructive"> = {
  draft: "secondary",
  ready: "outline",
  publishing: "default",
  published: "default",
  failed: "destructive",
};

export function StatusBadge({
  status,
  progress,
  className,
}: {
  status: DocumentStatus;
  progress?: number;
  className?: string;
}) {
  return (
    <Badge variant={STATUS_VARIANTS[status]} className={cn("gap-1", className)}>
      {STATUS_LABELS[status]}
      {status === "publishing" && progress !== undefined && (
        <span className="tabular-nums">{progress}%</span>
      )}
    </Badge>
  );
}
