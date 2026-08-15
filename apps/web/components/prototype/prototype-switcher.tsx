"use client";

// Shared floating switcher for UI prototypes (prototype skill): a fixed
// bottom-centre pill that cycles a ?variant= search param. Visually distinct
// from the app (dark pill + shadow) so it reads as "not part of the design
// being judged". Never render it outside a NODE_ENV !== "production" gate.

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export interface PrototypeVariant {
  key: string;
  label: string;
}

export function PrototypeSwitcher({
  variants,
  current,
  basePath = "/chat",
}: {
  variants: PrototypeVariant[];
  current: string;
  basePath?: string;
}) {
  const router = useRouter();

  const index = Math.max(0, variants.findIndex((v) => v.key === current));
  const go = (i: number): void => {
    const wrapped = ((i % variants.length) + variants.length) % variants.length;
    router.replace(`${basePath}?variant=${variants[wrapped].key}`, { scroll: false });
  };

  // Arrow keys cycle the variants — unless the user is typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const target = e.target as HTMLElement | null;
      if (target !== null && target.closest("input, textarea, [contenteditable]") !== null) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(index - 1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        go(index + 1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- throwaway; go() is stable for our purposes
  }, [index, variants, basePath]);

  if (process.env.NODE_ENV === "production") return null;

  return (
    <div
      role="group"
      aria-label="Prototype variant switcher"
      className="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full bg-foreground px-1.5 py-1 text-background shadow-2xl"
    >
      <button
        type="button"
        onClick={() => go(index - 1)}
        aria-label="Previous variant"
        className="flex size-7 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-background/20"
      >
        <ChevronLeft className="size-4" aria-hidden />
      </button>
      <span className="min-w-40 px-2 text-center text-xs font-semibold tabular-nums">
        {variants[index].key} — {variants[index].label}
      </span>
      <button
        type="button"
        onClick={() => go(index + 1)}
        aria-label="Next variant"
        className="flex size-7 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-background/20"
      >
        <ChevronRight className="size-4" aria-hidden />
      </button>
    </div>
  );
}
