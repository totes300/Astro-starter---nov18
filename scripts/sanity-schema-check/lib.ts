// The deployed schema against the local extract: Translate with AI's own field check, run over every document type.
// Pure, so it is unit tested; the CLI is ./check.ts. Workflow: ./README.md

import { schemaDrift } from "~/features/agents/translate";

export const EXTRACT_FILE = "sanity-schema.json";

export type SchemaComparison = {
  /** One line per difference, sorted; empty when the deployed schema matches. */
  drift: string[];
  /** A translated type differs, so Translate with AI refuses every run (`schema_drift`) until a deploy. */
  pausesTranslation: boolean;
  documentTypes: string[];
};

/** The deployed `schema` field is stored as a JSON string; anything but an array of types is unreadable. */
export function parseDeployedSchema(value: unknown): unknown[] | undefined {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;

    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// Sanity's own asset documents are in every extract and never in a deployed schema.
function documentTypes(schema: readonly unknown[]): string[] {
  return schema.flatMap((entry) => {
    const { name, type } = (entry ?? {}) as { name?: unknown; type?: unknown };

    return type === "document" && typeof name === "string" && !name.startsWith("sanity.") ? [name] : [];
  });
}

type Schemas = { deployed: readonly unknown[]; local: readonly unknown[] };

export function compareSchemas({ deployed, local }: Schemas): SchemaComparison {
  const localTypes = documentTypes(local);
  const removed = documentTypes(deployed)
    .filter((name) => !localTypes.includes(name))
    .map((name) => `${name}: in the deployed schema, removed here`);

  return {
    drift: [...new Set([...schemaDrift({ deployed, local, types: localTypes }), ...removed])].sort(),
    pausesTranslation: schemaDrift({ deployed, local }).length > 0,
    documentTypes: localTypes,
  };
}
