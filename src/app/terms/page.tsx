import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function TermsOfService() {
  return (
    <main className="min-h-screen bg-background text-foreground py-12 px-6">
      <div className="max-w-3xl mx-auto">
        <Button asChild variant="ghost" className="mb-8 -ml-4">
          <Link href="/">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Home
          </Link>
        </Button>
        <h1 className="text-4xl font-bold mb-8">Terms of Service</h1>
        <div className="prose prose-invert max-w-none text-muted-foreground space-y-6">
          <p>Last Updated: {new Date().toLocaleDateString()}</p>
          
          <h2 className="text-xl font-semibold text-foreground mt-8">1. Acceptance of Terms</h2>
          <p>
            By accessing and using this website, you accept and agree to be bound by the terms and provision of this agreement.
          </p>

          <h2 className="text-xl font-semibold text-foreground mt-8">2. Description of Service</h2>
          <p>
            We provide users with access to a rich collection of resources, including various communications tools, forums, shopping services, and personalized content.
          </p>

          <h2 className="text-xl font-semibold text-foreground mt-8">3. User Conduct</h2>
          <p>
            You agree to not use the Service to:
            <ul className="list-disc pl-6 mt-2">
              <li>Upload, post, email, transmit or otherwise make available any content that is unlawful, harmful, threatening, abusive, harassing, tortious, defamatory, vulgar, obscene, libelous, invasive of another&apos;s privacy, hateful, or racially, ethnically or otherwise objectionable.</li>
              <li>Harm minors in any way.</li>
              <li>Impersonate any person or entity.</li>
            </ul>
          </p>

          <h2 className="text-xl font-semibold text-foreground mt-8">4. Modifications to Service</h2>
          <p>
            We reserve the right at any time and from time to time to modify or discontinue, temporarily or permanently, the Service (or any part thereof) with or without notice.
          </p>

          <h2 className="text-xl font-semibold text-foreground mt-8">5. Contact Information</h2>
          <p>
            If you have any questions about these Terms, please contact us at:{" "}
            <a href="mailto:koushik9924@gmail.com" className="text-primary hover:underline">
              koushik9924@gmail.com
            </a>
          </p>
        </div>
      </div>
    </main>
  );
}
