// `sanity/config.ts` requires its env on import, and schema code reaches it for the API version.
// Imported first by a test that loads schema definitions: placeholders only where the environment has no value.

const PLACEHOLDER_ENV: Record<string, string> = {
  SANITY_STUDIO_PROJECT_ID: "test-project",
  SANITY_STUDIO_DATASET: "test",
  SANITY_STUDIO_SITE_URL: "https://example.com",
};

for (const [name, value] of Object.entries(PLACEHOLDER_ENV)) {
  process.env[name] ??= value;
}
