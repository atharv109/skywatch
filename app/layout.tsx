import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible, Be_Vietnam_Pro, Noto_Naskh_Arabic, Noto_Sans_SC } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const atkinson = Atkinson_Hyperlegible({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "700"],
  variable: "--font-sans",
  display: "swap",
});

const notoSc = Noto_Sans_SC({
  subsets: ["latin"],
  weight: ["400", "700"],
  variable: "--font-sc",
  display: "swap",
  preload: false,
});

const naskh = Noto_Naskh_Arabic({
  subsets: ["arabic", "latin"],
  weight: ["400", "700"],
  variable: "--font-ar",
  display: "swap",
  preload: false,
});

const viet = Be_Vietnam_Pro({
  subsets: ["latin", "vietnamese"],
  weight: ["400", "600", "700"],
  variable: "--font-vi",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: "Skywatch",
  description: "Get real-time hazards and open shelters in your language.",
  applicationName: "Skywatch",
};

export const viewport: Viewport = {
  themeColor: "#0c1214",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${atkinson.variable} ${notoSc.variable} ${naskh.variable} ${viet.variable} dark h-full antialiased`}
    >
      <body className="h-full bg-[#05080a] text-paper">
        <div className="phone-stage">
          <div className="phone-frame">
            {children}
            <Toaster />
          </div>
        </div>
      </body>
    </html>
  );
}
