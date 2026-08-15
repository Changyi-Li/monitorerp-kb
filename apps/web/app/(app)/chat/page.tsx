import { ChatPage } from "@/components/chat/chat-page";
import { CitationExpansionPrototype } from "@/components/chat/citation-prototype";
import { PrototypeSwitcher, type PrototypeVariant } from "@/components/prototype/prototype-switcher";

// THROWAWAY gate (prototype): /chat?variant=A|B|C|D shows the citation-
// expansion comparison on the same route; production builds always render
// the real chat. Delete the gate (and the prototype files) when a variant
// wins and is folded into chat-page.tsx.
const PROTOTYPE_VARIANTS: PrototypeVariant[] = [
  { key: "A", label: "Inline accordion" },
  { key: "B", label: "Docked sources drawer" },
  { key: "C", label: "Anchored popover" },
  { key: "D", label: "Auto-scroll baseline" },
];

export default async function ChatPageWrapper({
  searchParams,
}: {
  searchParams: Promise<{ variant?: string | string[] }>;
}) {
  const { variant } = await searchParams;
  const key = typeof variant === "string" ? variant : undefined;

  if (process.env.NODE_ENV !== "production" && key !== undefined) {
    const chosen = PROTOTYPE_VARIANTS.some((v) => v.key === key) ? key : "A";
    return (
      <>
        <CitationExpansionPrototype variant={chosen} />
        <PrototypeSwitcher variants={PROTOTYPE_VARIANTS} current={chosen} />
      </>
    );
  }
  return <ChatPage />;
}
