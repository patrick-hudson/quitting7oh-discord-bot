import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Quitting 7OH — Admin",
  description: "Scheduled meeting posts for the Quitting 7OH Discord",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
