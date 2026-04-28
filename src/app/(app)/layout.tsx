import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Sidebar } from "@/components/sidebar";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  return (
    <div className="flex h-screen w-screen overflow-hidden">
      <Sidebar userEmail={user.email ?? "(no email)"} />
      <section className="flex-1 overflow-hidden bg-background">{children}</section>
    </div>
  );
}
