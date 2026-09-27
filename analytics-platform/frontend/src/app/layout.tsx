import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { themeInitScript } from "@/lib/theme";

export const metadata: Metadata = {
  title: { default: "Analytics Platform", template: "%s · Analytics Platform" },
  description: "From raw data to deployed models and live dashboards.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
