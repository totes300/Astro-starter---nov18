// The app's own time budget per request, which long routes count against: a Worker has no wall-clock cap.
// Import-free, so the config can read it.

export const FUNCTION_MAX_DURATION_SECONDS = 60;

export const FUNCTION_CAP_MS = FUNCTION_MAX_DURATION_SECONDS * 1000;
