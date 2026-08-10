"use client";

// PROTOTYPE root — mounts one of the two chat variants based on ?variant= and
// renders the floating switcher. Lives inside a mock shell (real auth not
// required) so the variants are viewable without the backend.

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect } from "react";

import { PROTOTYPE_VARIANTS, type VariantKey } from "@/components/prototype-chat/shared";
import { VariantA } from "@/components/prototype-chat/variant-a";
import { VariantB } from "@/components/prototype-chat/variant-b";

const KEYS = PROTOTYPE_VARIANTS.map((v) => v.key);

export function ChatPrototype() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const raw = searchParams.get("variant");
  const current: VariantKey = (KEYS as readonly string[]).includes(raw ?? "") ? (raw as VariantKey) : "A";

  const go = useCallback(
    (key: VariantKey) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("variant", key);
      router.replace(`/prototype-chat?${params.toString()}`, { scroll: false });
    },
    [searchParams, router],
  );

  const cycle = useCallback(
    (dir: 1 | -1) => {
      const idx = KEYS.indexOf(current);
      go(KEYS[(idx + dir + KEYS.length) % KEYS.length]!);
    },
    [current, go],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t !== null && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        cycle(-1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        cycle(1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cycle]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="relative min-h-0 flex-1">
        {current === "A" && <VariantA />}
        {current === "B" && <VariantB />}
      </div>
      {process.env.NODE_ENV !== "production" && (
        <PrototypeSwitcher current={current} onPrev={() => cycle(-1)} onNext={() => cycle(1)} />
      )}
    </div>
  );
}

function PrototypeSwitcher({
  current,
  onPrev,
  onNext,
}: {
  current: VariantKey;
  onPrev: () => void;
  onNext: () => void;
}) {
  const active = PROTOTYPE_VARIANTS.find((v) => v.key === current);
  return (
    <div className="pointer-events-none absolute bottom-4 left-1/2 z-30 -translate-x-1/2">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border bg-background/95 p-1 shadow-lg backdrop-blur">
        <button
          type="button"
          onClick={onPrev}
          aria-label="Previous variant"
          className="inline-flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <span className="min-w-[11rem] text-center text-xs font-medium tabular-nums">
          <span className="text-foreground">{current}</span>
          <span className="text-muted-foreground"> — {active?.name}</span>
        </span>
        <button
          type="button"
          onClick={onNext}
          aria-label="Next variant"
          className="inline-flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronRight className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
