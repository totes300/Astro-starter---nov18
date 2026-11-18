import { Button, Card, Flex, Spinner, Stack, Text } from "@sanity/ui";
import { useToast } from "@sanity/ui/toast";
import * as React from "react";
import type { ArrayOfObjectsInputProps } from "sanity";
import { sanityConfig } from "../config";
import { useStudioFetch } from "../lib/studio-fetch";
import { readStudioJson, studioFailure } from "../lib/studio-response";

/**
 * The `redirects` editor plus a Redeploy site button: redirects are read at build, so edits need a rebuild.
 * The button asks the app's `redeploy` route, which holds the deploy trigger; the Studio bundle is public.
 */
function RedirectsDeployInput(props: ArrayOfObjectsInputProps) {
  const studioFetch = useStudioFetch();
  const toast = useToast();
  const [isDeploying, setIsDeploying] = React.useState(false);

  const runRedeploy = async () => {
    setIsDeploying(true);

    try {
      const res = await studioFetch(sanityConfig.endpoints.redeploy, { method: "POST" });
      const payload = await readStudioJson<{ error?: string; hint?: string }>(res);

      if (!res.ok) {
        const reason = studioFailure(res, payload, "The deploy could not be started.");
        throw new Error(payload?.hint ? `${reason} ${payload.hint}` : reason);
      }

      toast.push({
        status: "success",
        title: "Redeploy started",
        description: "The site is rebuilding. Redirect changes go live when the deploy finishes, usually within a few minutes.",
      });
    } catch (err) {
      toast.push({
        status: "error",
        title: "Redeploy failed",
        description: err instanceof Error ? err.message : "Unknown error.",
      });
    } finally {
      setIsDeploying(false);
    }
  };

  return (
    <Stack gap={3}>
      {props.renderDefault(props)}

      <Card border padding={3} radius={2} tone="transparent">
        <Stack gap={4}>
          <Stack gap={3}>
            <Text size={1} weight="medium">
              Apply redirect changes
            </Text>
            <Text size={1} muted>
              Redirects are baked in when the site builds, so edits above only take effect after a rebuild. Publish your changes
              first, then redeploy to apply them.
            </Text>
          </Stack>

          <Flex align="center" gap={3}>
            <Button
              text={isDeploying ? "Starting..." : "Redeploy site"}
              tone="primary"
              disabled={isDeploying}
              onClick={() => void runRedeploy()}
            />

            {isDeploying && (
              <Flex align="center" gap={2}>
                <Spinner muted />
                <Text size={1} muted>
                  Starting the deploy.
                </Text>
              </Flex>
            )}
          </Flex>
        </Stack>
      </Card>
    </Stack>
  );
}

export { RedirectsDeployInput };
