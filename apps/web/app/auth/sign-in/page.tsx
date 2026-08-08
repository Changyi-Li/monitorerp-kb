import type { Metadata } from "next";
import { BookOpen } from "lucide-react";

import { SignInForm } from "@/components/auth/sign-in-form";

export const metadata: Metadata = { title: "Sign in — MonitorERP KB" };

export default function SignInPage() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 bg-muted/40 p-6">
      <div className="flex items-center gap-2">
        <BookOpen className="size-6 text-primary" aria-hidden />
        <span className="text-lg font-semibold">MonitorERP KB</span>
      </div>
      <SignInForm />
    </div>
  );
}
