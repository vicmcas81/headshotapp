// app/layout.tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Headshots — Professional photos from your selfies",
  description: "Turn 10 selfies into 50 stunning professional headshots in 15 minutes. Pay only if you love them.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
