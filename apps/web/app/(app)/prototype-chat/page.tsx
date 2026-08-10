import { Suspense } from "react";

import { ChatPrototype } from "@/components/prototype-chat/chat-prototype";

// PROTOTYPE — throwaway route for the chatbot UI variants. Renders inside the
// real AppShell (real auth). Switch variants with ?variant=A|B|C or the floating
// bar. Remove this route and components/prototype-chat/ once a variant wins.
export default function PrototypeChatPage() {
  return (
    <Suspense fallback={null}>
      <ChatPrototype />
    </Suspense>
  );
}
