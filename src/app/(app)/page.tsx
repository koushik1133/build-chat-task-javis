import { redirect } from "next/navigation";

/** The app root lands on the home dashboard. */
export default function AppIndexPage() {
  redirect("/home");
}
