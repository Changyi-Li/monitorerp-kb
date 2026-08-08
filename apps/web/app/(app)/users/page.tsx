import { Users } from "lucide-react";

export default function UsersPage() {
  return (
    <>
      <header className="border-b px-6 py-4">
        <h1 className="text-lg font-semibold">Users</h1>
        <p className="text-sm text-muted-foreground">Manage users and access</p>
      </header>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <div className="flex size-10 items-center justify-center rounded-full bg-muted">
            <Users className="size-5 text-muted-foreground" aria-hidden />
          </div>
          <h2 className="text-base font-semibold">Not available yet</h2>
          <p className="text-sm text-muted-foreground">
            User administration — activation, roles, deactivation — arrives in a later milestone
            and is limited to super admins.
          </p>
        </div>
      </div>
    </>
  );
}
