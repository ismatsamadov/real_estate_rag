import "./globals.css";
import { Inter, Playfair_Display } from "next/font/google";
import { FavoritesProvider } from "./components/FavoritesContext";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const playfair = Playfair_Display({
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

export const metadata = {
  title: "PASHA Real Estate Search",
  description:
    "Grounded Q&A over PASHA Real Estate's curated luxury portfolio in Baku — Crescent Residences, St. Regis Baku, Knightsbridge, Ritz-Carlton Residences.",
  keywords: [
    "Baku real estate",
    "PASHA Real Estate",
    "luxury apartments",
    "Crescent Residences",
    "St Regis Baku",
  ],
};

export const viewport = {
  themeColor: "#0a0a0a",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,           // allow zoom for accessibility — never lock to 1
  viewportFit: "cover" as const, // extend behind iPhone notch + home bar
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${playfair.variable}`}>
      <body className="font-sans">
        <FavoritesProvider>{children}</FavoritesProvider>
      </body>
    </html>
  );
}
