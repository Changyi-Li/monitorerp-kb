import { FileText } from "lucide-react";

export default function DocumentsPage() {
  return (
    <>
      <header className="border-b px-6 py-4">
        <h1 className="text-lg font-semibold">Documents</h1>
        <p className="text-sm text-muted-foreground">
          Upload, review, and publish knowledge documents
        </p>
      </header>
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <div className="flex size-10 items-center justify-center rounded-full bg-muted">
            <FileText className="size-5 text-muted-foreground" aria-hidden />
          </div>
          <h2 className="text-base font-semibold">No documents yet</h2>
          <p className="text-sm text-muted-foreground">
            Document uploads and the lifecycle workflow arrive in a later milestone.
          </p>
        </div>
      </div>
    </>
  );
}
