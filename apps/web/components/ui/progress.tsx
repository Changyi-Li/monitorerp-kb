import { cn } from "@/lib/utils";

export function Progress({ value, className }: { value: number; className?: string }) {
  const percent = Math.min(100, Math.max(0, value));
  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <div
        className="h-full rounded-full bg-primary transition-[width] motion-safe:duration-300"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}
