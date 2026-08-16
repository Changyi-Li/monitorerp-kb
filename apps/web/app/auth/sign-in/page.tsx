import type { Metadata } from "next";
import { BookOpen } from "lucide-react";

import { SignInForm } from "@/components/auth/sign-in-form";

export const metadata: Metadata = { title: "Sign in — MonitorERP KB" };

/**
 * Issue #62: a failed OIDC sign-in lands back here with `error=oidc_failed`
 * (the API's callback redirects to the web origin with the parameter, and the
 * proxy carries it from the root to this page). The message renders in the
 * form's existing error slot; password sign-in and the sign-up page are
 * untouched.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const oidcFailed = params.error === "oidc_failed";
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 bg-muted/40 p-6">
      <div className="flex items-center gap-2">
        <BookOpen className="size-6 text-primary" aria-hidden />
        <span className="text-lg font-semibold">MonitorERP KB</span>
      </div>
      <SignInForm
        initialError={
          oidcFailed ? "Sign in with Keycloak failed. Try again or use your password." : null
        }
      />
    </div>
  );
}
