import { FileUploader } from "@/components/file-uploader";

export default function FilesPage() {
  return (
    <div className="h-full overflow-y-auto px-8 py-8">
      <div className="mx-auto max-w-2xl">
        <h1 className="text-2xl font-semibold tracking-tight">Files</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upload reference material. Javis will retrieve relevant chunks on every chat.
        </p>
        <div className="mt-8">
          <FileUploader />
        </div>
      </div>
    </div>
  );
}
