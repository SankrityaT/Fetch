import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";

/* The same four faces the app bundles, served from our own origin. No Google
   Fonts request, and the site renders in the product's type or not at all.

   Only the weights actually rendered are declared here. next/font preloads
   every weight it is given, and five unused files were sitting on the LCP
   path. The rest of the family is in public/fonts; add a weight here the
   moment a section needs it, and not before. */

const display = localFont({
  variable: "--f-display",
  display: "swap",
  src: [
    { path: "../public/fonts/BricolageGrotesque-800.woff2", weight: "800", style: "normal" },
  ],
});

const ui = localFont({
  variable: "--f-ui",
  display: "swap",
  src: [
    { path: "../public/fonts/Geist-400.woff2", weight: "400", style: "normal" },
    { path: "../public/fonts/Geist-600.woff2", weight: "600", style: "normal" },
  ],
});

const serif = localFont({
  variable: "--f-serif",
  display: "swap",
  src: [
    { path: "../public/fonts/InstrumentSerif-400-italic.woff2", weight: "400", style: "italic" },
  ],
});

const mono = localFont({
  variable: "--f-mono",
  display: "swap",
  src: [
    { path: "../public/fonts/GeistMono-400.woff2", weight: "400", style: "normal" },
  ],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://fetch.app"),
  title: "Fetch. Record it. Fetch it. Ship it.",
  description:
    "A macOS screen recorder and editor that runs entirely on your Mac. Move the camera bubble after you record. No account, no upload, no subscription.",
  icons: { icon: "/fetch-icon-1024.png" },
  openGraph: {
    title: "Fetch. Record it. Fetch it. Ship it.",
    description:
      "A macOS screen recorder and editor that runs entirely on your Mac. No account, no upload, no subscription.",
    images: ["/shots/editor.png"],
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#0A0908",
  colorScheme: "dark",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${display.variable} ${ui.variable} ${serif.variable} ${mono.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
