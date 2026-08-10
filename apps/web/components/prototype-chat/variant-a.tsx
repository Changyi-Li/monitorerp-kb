"use client";

import { TwoPaneChat } from "@/components/prototype-chat/two-pane";

// Variant A — two-pane layout WITH the collapsible Sources list under each answer.
export function VariantA() {
  return <TwoPaneChat showSources />;
}
