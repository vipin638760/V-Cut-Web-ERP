import { Outfit, Great_Vibes, Space_Grotesk, Manrope } from "next/font/google";
import "./globals.css";

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
  weight: ["300", "400", "500", "600", "700", "800"],
});

const greatVibes = Great_Vibes({
  subsets: ["latin"],
  variable: "--font-vibes",
  weight: ["400"],
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-headline",
  weight: ["300", "400", "500", "600", "700"],
});

const manrope = Manrope({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["300", "400", "500", "600", "700"],
});

export const metadata = {
  title: "V-CUT Group — Management System",
  description: "Salon Management System",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${outfit.variable} ${greatVibes.variable} ${spaceGrotesk.variable} ${manrope.variable} antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: `(function(){try{var t=localStorage.getItem("vcut_theme");if(t==="light")document.documentElement.classList.add("light-mode")}catch(e){}})()` }} />
      </head>
      <body suppressHydrationWarning className="min-h-screen flex flex-col relative w-full overflow-x-hidden">
        <div className="global-watermark">
          <span style={{ color: "#f06464", fontFamily: "var(--font-vibes)", fontWeight: 400, fontSize: "1.4em", paddingRight: "4px" }}>V</span>
          <span style={{ color: "var(--text)", fontFamily: "var(--font-vibes)", fontWeight: 400, fontSize: "1.2em" }}>-Cut</span>
        </div>
        {children}
      </body>
    </html>
  );
}
