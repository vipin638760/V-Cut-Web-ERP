import { ImageResponse } from "next/og";

// Dynamic favicon so we can use the Great Vibes script V from the brand.
// A plain SVG favicon would not have access to Google Fonts, so we render
// the glyph via satori (ImageResponse) and embed the TTF at request time.

export const size = { width: 64, height: 64 };
export const contentType = "image/png";

const GREAT_VIBES_TTF =
  "https://fonts.gstatic.com/s/greatvibes/v19/RWmMoKWR9v4ksMfaWd_JN-XCg6UKDXlq.ttf";

export default async function Icon() {
  let fontData = null;
  try {
    const res = await fetch(GREAT_VIBES_TTF, { cache: "force-cache" });
    if (res.ok) fontData = await res.arrayBuffer();
  } catch {
    // Fall through to cursive fallback
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
            color: "#f06464",
            fontSize: 92,
            lineHeight: 1,
            transform: "translateY(10px)",
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
