import { GithubPanel } from "@/components/github-panel";
import { PageContainer } from "@/components/page-container";

export default function GithubPage() {
  return (
    <PageContainer
      wide
      title="GitHub"
      description="Paste any public repo URL. KernelHub can review the largest source files or generate a README."
    >
      <GithubPanel />
    </PageContainer>
  );
}
