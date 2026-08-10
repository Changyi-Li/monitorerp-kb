import { Suspense } from "react";

import { ChatPrototype } from "@/components/prototype-chat/chat-prototype";
import { PrototypeShell } from "@/components/prototype-chat/mock-shell";

// PROTOTYPE — throwaway route for the chatbot UI variants. Lives OUTSIDE the
// (app) group on purpose: no login and no backend required. The PrototypeShell
// mimics the real app nav so the variants are judged in context (Chat next to
// Documents/Users). Switch variants with ?variant=A|B|C or the floating bar.
// Remove this route and components/prototype-chat/ once a variant wins.
export default function PrototypeChatPage() {
  return (
    <PrototypeShell>
      <Suspense fallback={null}>
        <ChatPrototype />
      </Suspense>
    </PrototypeShell>
  );
}
