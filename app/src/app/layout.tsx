import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Sitecore Package Manager",
  description:
    "Sitecore Marketplace app to install and create classic-format Sitecore packages (items) for SitecoreAI / XM Cloud.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>
        {children}
      </body>
    </html>
  );
}
