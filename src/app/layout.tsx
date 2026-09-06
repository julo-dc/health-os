import "./globals.css";
import type { Metadata, Viewport } from "next";
import { getUser } from "@/lib/auth";
import { Nav } from "@/components/nav";

export const metadata: Metadata = {
  title: "Vector — goal intelligence",
  description: "Your health, training and work data, pointed at one goal.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getUser().catch(() => null);
  return (
    <html lang="en">
      <body>
        {user ? <Nav user={{ name: user.name, email: user.email, picture: user.picture }} /> : null}
        <main className={user ? "mx-auto max-w-[1400px] px-4 pb-24 pt-6 sm:px-6" : ""}>{children}</main>
      </body>
    </html>
  );
}
