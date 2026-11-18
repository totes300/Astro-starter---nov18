import type { ValidationContext } from "sanity";
import { sanityConfig } from "../config";

/** A read that fails (offline, or no client outside the Studio) flags nothing, rather than a problem the editor cannot fix. */
export async function readForValidation<T>(
  context: ValidationContext,
  query: string,
  params: Record<string, unknown>
): Promise<T | undefined> {
  try {
    return await context.getClient({ apiVersion: sanityConfig.apiVersion }).fetch<T>(query, params);
  } catch {
    return undefined;
  }
}
