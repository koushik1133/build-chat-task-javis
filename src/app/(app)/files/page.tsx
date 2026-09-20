import { FileUploader } from "@/components/file-uploader";
import { PageContainer } from "@/components/page-container";

export default function FilesPage() {
  return (
    <PageContainer
      title="Files"
      description="Upload reference material. KernelHub will retrieve relevant chunks on every chat."
      tooltip="Upload documents here. The AI reads them and uses the content to answer your questions more accurately."
    >
      <FileUploader />
    </PageContainer>
  );
}
