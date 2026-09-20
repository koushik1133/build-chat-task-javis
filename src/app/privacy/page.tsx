import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function PrivacyPolicy() {
  return (
    <main className="min-h-screen bg-background text-foreground py-12 px-6">
      <div className="max-w-3xl mx-auto">
        <Button asChild variant="ghost" className="mb-8 -ml-4">
          <Link href="/">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Home
          </Link>
        </Button>
        <h1 className="text-4xl font-bold mb-8">Privacy Policy</h1>
        <div className="prose prose-invert max-w-none text-muted-foreground space-y-6">
          <p>Last Updated: {new Date().toLocaleDateString()}</p>
          
          <h2 className="text-xl font-semibold text-foreground mt-8">1. Information We Collect</h2>
          <p>
            We collect information you provide directly to us, such as when you create or modify your account, request on-demand services, contact customer support, or otherwise communicate with us. This information may include: name, email, phone number, postal address, profile picture, payment method, and other information you choose to provide.
          </p>

          <h2 className="text-xl font-semibold text-foreground mt-8">2. How We Use Information</h2>
          <p>
            We use the information we collect to provide, maintain, and improve our services, such as to facilitate payments, send receipts, provide products and services you request, develop new features, provide customer support, and send product updates and administrative messages.
          </p>

          <h2 className="text-xl font-semibold text-foreground mt-8">3. Information Sharing</h2>
          <p>
            We may share the information we collect about you as described in this Statement or as described at the time of collection or sharing, including as follows: with vendors, consultants, marketing partners, and other service providers who need access to such information to carry out work on our behalf.
          </p>

          <h2 className="text-xl font-semibold text-foreground mt-8">4. Security</h2>
          <p>
            We take reasonable measures to help protect information about you from loss, theft, misuse and unauthorized access, disclosure, alteration and destruction.
          </p>

          <h2 className="text-xl font-semibold text-foreground mt-8">5. Contact Us</h2>
          <p>
            If you have any questions about this Privacy Policy, please contact us at:{" "}
            <a href="mailto:koushik9924@gmail.com" className="text-primary hover:underline">
              koushik9924@gmail.com
            </a>
          </p>
        </div>
      </div>
    </main>
  );
}
