import { parseLottieAssetDimensionsFromBuffer } from "../lib/parse-lottie-dimensions";
import { createAssetDimensionsInput } from "./asset-dimensions-input";

export const LottieFileInput = createAssetDimensionsInput({
  label: "Lottie",
  dimensionsFieldName: "lottieDimensions",
  parse: parseLottieAssetDimensionsFromBuffer,
  noDimensionsMessage: "The Lottie player could not open this file. Check it plays, or enter the dimensions manually.",
});
