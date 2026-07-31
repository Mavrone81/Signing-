import { redirect } from "next/navigation";

// `/documents` is the app's first user-visible screen; `/middleware.ts`
// already gates unauthenticated access to everything except /login.
export default function Home() {
  redirect("/documents");
}
