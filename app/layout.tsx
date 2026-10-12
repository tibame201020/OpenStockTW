import type { Metadata } from "next";
import { Analytics } from "@vercel/analytics/next";
import {Toaster} from "@/components/ui/sonner";
import OntoLaunchCard from "@/components/OntoLaunchCard";
import "./globals.css";

// TW fork: the self-hosted woff2 files (app/fonts/*) are not shipped in this
// repo snapshot, so we fall back to system font stacks. The CSS variable names
// (--font-jakarta / --font-plex-mono) are unchanged, and globals.css defines
// them as system stacks, so all styling below is untouched.
// To restore the original fonts: drop the woff2 files back into app/fonts/
// and switch these back to next/font/local.
const jakarta = { variable: "--font-jakarta" };
const plexMono = { variable: "--font-plex-mono" };

export const metadata: Metadata = {
  title: "OpenStock",
  description: "OpenStock is an open-source alternative to expensive market platforms. Track real-time prices, set personalized alerts, and explore detailed company insights — built openly, for everyone, forever free.",
};

export default function RootLayout({
                                       children,
                                   }: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <html lang="en" className="dark">
            <body
                className={`${jakarta.variable} ${plexMono.variable} font-sans antialiased`}
            >
                {children}
                <Toaster/>
                <OntoLaunchCard />
                <Analytics />
            </body>
        </html>
    );
}
