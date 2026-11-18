// The Lottie player draws at 75% of the screen's density by default, which blurs fine lines and small type.
// Every Lottie draws at the screen's full density instead, never below 2x, so a 1x screen still gets smooth edges.
const MIN_DEVICE_PIXEL_RATIO = 2;

const renderConfig = (devicePixelRatio: number) => JSON.stringify({ devicePixelRatio });

/** Served on the element, for one that upgrades the moment it is inserted (after a page transition). */
export const LOTTIE_RENDER_CONFIG = renderConfig(MIN_DEVICE_PIXEL_RATIO);

/** The element reads `renderconfig` once, as it upgrades, so the screen's density is set on every waiting host first. */
export async function loadLottiePlayer() {
  const config = renderConfig(Math.max(MIN_DEVICE_PIXEL_RATIO, window.devicePixelRatio || 1));

  for (const host of document.querySelectorAll("dotlottie-wc:not(:defined)")) {
    host.setAttribute("renderconfig", config);
  }

  await import("@lottiefiles/dotlottie-wc");
}
