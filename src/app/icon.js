import { ImageResponse } from "next/og";

// Brand favicon — Great Vibes script V on a dark tile, matching the sidebar logo.
// Rendered via satori/ImageResponse so we can embed the TTF; a static SVG
// favicon cannot load Google Fonts.

export const size = { width: 512, height: 512 };
export const contentType = "image/png";

// jsdelivr serves the raw Great Vibes TTF from the Google Fonts repo.
// satori (under ImageResponse) reliably accepts TTF; gstatic only serves woff2.
const GREAT_VIBES_TTF =
  "https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/greatvibes/GreatVibes-Regular.ttf";

export default async function Icon() {
  let fontData = null;
  try {
    const res = await fetch(GREAT_VIBES_TTF, { cache: "force-cache" });
    if (res.ok) fontData = await res.arrayBuffer();
  } catch {
    // Fall back to system cursive if the font CDN is unreachable.
  }

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          background: "transparent",
        }}
      >
        <span
          style={{
            fontFamily: fontData ? "GreatVibes" : "cursive",
            color: "#ef4444",
            fontSize: 440,
            lineHeight: 1,
            transform: "translateY(40px)",
            fontWeight: 400,
            // Faux-bold the thin script: stack offset shadows around the glyph
            // so the cursive curves thicken and survive downscaling to 16px.
            textShadow:
              "6px 0 0 #ef4444, -6px 0 0 #ef4444, 0 6px 0 #ef4444, 0 -6px 0 #ef4444, 4px 4px 0 #ef4444, -4px 4px 0 #ef4444, 4px -4px 0 #ef4444, -4px -4px 0 #ef4444",
          }}
        >
          V
        </span>
      </div>
    ),
    {
      ...size,
      ...(fontData
        ? {
            fonts: [
              {
                name: "GreatVibes",
                data: fontData,
                style: "normal",
                weight: 400,
              },
            ],
          }
        : {}),
    }
  );
}
