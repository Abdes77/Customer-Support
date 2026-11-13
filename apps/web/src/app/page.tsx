import { redirect } from "next/navigation";

/** The admin panel starts at the business list; signed-out visitors go to sign-in from there. */
export default function HomePage() {
  redirect("/businesses");
}
