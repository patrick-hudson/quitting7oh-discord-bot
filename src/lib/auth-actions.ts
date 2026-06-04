"use server";

import { signOut } from "@/auth";

// Server action wrapper around NextAuth's signOut. Imported by client
// components (e.g. the sidebar's user menu) so they can sign out via a form
// without needing to call the server-side signOut directly.
export async function signOutAction() {
  await signOut({ redirectTo: "/login" });
}
