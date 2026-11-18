// Measures a Lottie (.json or .lottie) with the dotLottie engine the site's Lottie player runs on.
// The engine owns every format question, so a file it cannot open reports no dimensions, not a guess.
import type { DotLottie } from "@lottiefiles/dotlottie-web";

type Dimensions = { width: number; height: number };

// Only start-up waits: the first click downloads the engine's WASM, so allow a slow connection.
const READY_TIMEOUT_MS = 20_000;

export async function parseLottieAssetDimensionsFromBuffer(buffer: ArrayBuffer): Promise<Dimensions | null> {
  const { DotLottie } = await import("@lottiefiles/dotlottie-web");

  const player = new DotLottie({
    canvas: document.createElement("canvas"),
    autoplay: false,
    renderConfig: { autoResize: false, freezeOnOffscreen: false },
  });

  try {
    if (!(await whenReady(player))) {
      return null;
    }

    return loadAndMeasure(player, buffer);
  } finally {
    player.destroy();
  }
}

function whenReady(player: DotLottie): Promise<boolean> {
  if (player.isReady) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const timeout = window.setTimeout(() => resolve(false), READY_TIMEOUT_MS);

    player.addEventListener("ready", () => {
      window.clearTimeout(timeout);
      resolve(true);
    });
  });
}

// The engine reads a dotLottie as bytes and Lottie JSON as text, so the bytes go first, then the text.
function loadAndMeasure(player: DotLottie, buffer: ArrayBuffer): Dimensions | null {
  // A ready engine loads synchronously and drops a broken archive without an event: `isLoaded` decides.
  player.load({ data: buffer });

  if (!player.isLoaded) {
    player.load({ data: new TextDecoder().decode(buffer) });
  }

  if (!player.isLoaded) {
    return null;
  }

  const { width, height } = player.animationSize();

  return width > 0 && height > 0 ? { width: Math.round(width), height: Math.round(height) } : null;
}
