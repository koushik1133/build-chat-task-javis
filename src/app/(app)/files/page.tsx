import { FileUploader } from "@/components/file-uploader";
import { PageContainer } from "@/components/page-container";

export default function FilesPage() {
  return (
    <PageContainer
      title="Files"
      description="Upload reference material. KernelHub will retrieve relevant chunks on every chat."
    >
      <FileUploader />
    </PageContainer>
  );
}
