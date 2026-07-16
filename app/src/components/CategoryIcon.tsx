// Category icons. The source SVGs live in app/public/icons/ (monochrome
// silhouettes in a 100×100 viewBox). Each is rendered as a CSS mask filled with
// `currentColor`, so the parent's text color drives the glyph color: faded
// white on the dark detail hero band, the category color on chips/cards,
// exactly as the old inline glyphs did. Referencing the public files (rather
// than inlining their paths) keeps the SVGs the single source of truth: edit a
// file in public/icons/ and the app picks it up. The BASE_URL prefix makes the
// path correct under the deployed base (/cdot_tdm_calculator/).

import type { StrategyCategoryId } from "../strategies/registry";

// One icon per category. `programmatic` (marketing) has no dedicated art yet
// and no strategies, so it falls back to the supportive icon below; if a
// marketing strategy ever lands, drop a programmatic.svg in public/icons/ and
// add it here.
const CAT_ICON: Partial<Record<StrategyCategoryId, string>> = {
  transit: "transit.svg",
  bikeped: "bike-ped.svg",
  landuse: "land-use.svg",
  vanpool: "vanpool.svg",
  support: "supportive-programmatic.svg",
  induced: "induced-demand.svg",
  parking: "parking-management.svg",
  electrification: "electrification.svg",
  freight: "freight.svg",
  technology: "technology.svg",
};

interface CategoryIconProps {
  cat: StrategyCategoryId;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function CategoryIcon({ cat, size = 18, className, style }: CategoryIconProps) {
  const file = CAT_ICON[cat] ?? CAT_ICON.support!;
  const url = `url("${import.meta.env.BASE_URL}icons/${file}")`;
  return (
    <span
      className={className}
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: size,
        height: size,
        flex: "0 0 auto",
        backgroundColor: "currentColor",
        WebkitMaskImage: url,
        maskImage: url,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
        ...style,
      }}
    />
  );
}
