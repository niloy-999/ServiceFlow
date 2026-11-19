import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ServiceFlow",
  description: "Retail and repair management platform for computer shops and service centres.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
