"use client";

import { TwoPaneChat } from "@/components/prototype-chat/two-pane";

// Variant B — same two-pane layout, but the Sources list is removed entirely;
// citations are reachable only by clicking the inline [n] markers.
export function VariantB() {
  return <TwoPaneChat showSources={false} />;
}
