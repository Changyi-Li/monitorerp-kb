import { ChatPage } from "@/components/chat/chat-page";
import { CitationExpansionPrototype } from "@/components/chat/citation-prototype";

// THROWAWAY gate (prototype): /chat?variant=* shows the combined citation-
// expansion prototype (inline by default, side panel opt-in); production
// builds always render the real chat. Delete the gate (and the prototype
// file) when the design is folded into chat-page.tsx. The earlier A–D
// variant comparison lives on branch prototype/citation-expansion-variants.
export default async function ChatPageWrapper({
  searchParams,
}: {
  searchParams: Promise<{ variant?: string | string[] }>;
}) {
  const { variant } = await searchParams;
  const key = typeof variant === "string" ? variant : undefined;

  if (process.env.NODE_ENV !== "production" && key !== undefined) {
    return <CitationExpansionPrototype />;
  }
  return <ChatPage />;
}
