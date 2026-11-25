// The contractor logo printed on a project's sheets. Sussex is built under the
// IBT joint venture and goes out with IBT's mark (not TVIG's, per Phil's team,
// 2026-11-25). Projects not listed print without one.

const PRINT_LOGO: Record<string, { src: string; alt: string }> = {
  // Sussexx CSG 1 LLC
  "39154377-bd1a-48ea-acdc-5d9b568863c9": { src: "/brand/ibt-logo.png", alt: "IBT Group USA" },
};

export function printLogo(projectId: string): { src: string; alt: string } | null {
  return PRINT_LOGO[projectId] ?? null;
}
