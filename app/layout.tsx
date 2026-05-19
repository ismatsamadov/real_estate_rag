import "./globals.css";

export const metadata = {
  title: "PASHA Real Estate Search",
  description:
    "Grounded Q&A over PASHA Real Estate's curated luxury portfolio in Baku — Crescent Residences, St. Regis Baku, Knightsbridge, Ritz-Carlton Residences.",
  keywords: ["Baku real estate", "PASHA Real Estate", "luxury apartments", "Crescent Residences", "St Regis Baku"],
};

export const viewport = {
  themeColor: "#c89148",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
