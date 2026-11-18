// This file is executed in the browser as part of the embedded Studio served by Astro at `/studio`
// (configured via `studioBasePath` in astro.config.mjs).

import { visionTool } from "@sanity/vision";
import { defineConfig } from "sanity";
import { defineDocuments, presentationTool } from "sanity/presentation";
import { structureTool } from "sanity/structure";
import { media, mediaAssetSource } from "sanity-plugin-media";
import { muxInput } from "sanity-plugin-mux-input";
import { createDocumentActions } from "./sanity/actions";
import { autoAltTextPlugin } from "./sanity/auto-alt-text";
import { sanityConfig } from "./sanity/config";
import { SHARED_ROUTED_DOCUMENT_TYPES, SINGLETON_IDS } from "./sanity/constants";
import { mediaLocaleOptions, translationPlugins, withAiTranslationRecord, withTranslationExclusions } from "./sanity/i18n-studio";
import { schemaTypes } from "./sanity/schemas";
import { sharedDocumentPath } from "./sanity/sections";
import { buildStructure } from "./sanity/structure";
import { CONFIGURED_LANGUAGE_FILTER } from "./sanity/structure-groups";
import { createDocumentTemplates } from "./sanity/templates";

const isDev = import.meta.env.DEV;

export default defineConfig({
  // Keeps the session token readable by the Studio, so `studioFetch` can prove to this app's API routes
  // who is calling. Cookie auth would hide it in an httpOnly cookie on api.sanity.io.
  auth: { loginMethod: "token" },
  title: "The Content Architecture",
  projectId: sanityConfig.projectId,
  dataset: sanityConfig.dataset,
  basePath: sanityConfig.studioBasePath,
  schema: {
    types: schemaTypes.map((type) => withTranslationExclusions(withAiTranslationRecord(type))),
    templates: createDocumentTemplates,
  },
  document: {
    actions: createDocumentActions,
  },
  form: {
    // Restrict image uploads to use the media browser.
    image: {
      assetSources: () => [mediaAssetSource],
    },
    // Don't use the media browser for anything that is not an image source.
    file: {
      assetSources: (prev) => prev.filter((source) => source !== mediaAssetSource),
    },
  },
  plugins: [
    structureTool({
      structure: buildStructure,
      title: "Content",
    }),
    media({
      maximumUploadSize: 10000000, // 10MB
      creditLine: { enabled: false },
      directUploads: false,
      ...mediaLocaleOptions,
    }),
    muxInput({
      tool: { title: "Mux" },
      encoding_tier: "baseline",
      disableUploadConfig: true,
      max_resolution_tier: "2160p",
      allowedRolesForConfiguration: ["administrator"],
    }),
    autoAltTextPlugin(),
    ...translationPlugins,
    // Live preview. previewUrl origin is omitted so it defaults to the embedded Studio's own (same) origin.
    presentationTool({
      resolve: {
        // Documents that map to a route, so the Studio updates its content side panel while navigating in preview.
        // `/*uri` matches every depth and language, since `uri` stores the full path; an unserved language renders a 404.
        mainDocuments: defineDocuments([
          { route: `/`, filter: `_id == "${SINGLETON_IDS.homepage}"` },
          {
            route: `/*uri`,
            // A shared routed document stores one unprefixed URI, served under every language's prefix.
            filter: (ctx) =>
              `defined(uri.current) && (uri.current == "${ctx.path}" || (_type in ${JSON.stringify(SHARED_ROUTED_DOCUMENT_TYPES)} && uri.current == "${sharedDocumentPath(ctx.path)}")) && ${CONFIGURED_LANGUAGE_FILTER}`,
          },
        ]),
      },
      previewUrl: {
        initial: "/",
        previewMode: {
          enable: sanityConfig.endpoints.draftModeEnable,
          disable: sanityConfig.endpoints.draftModeDisable,
        },
      },
    }),
    ...(isDev
      ? [
          visionTool({
            defaultApiVersion: sanityConfig.apiVersion,
          }),
        ]
      : []),
  ],
});
