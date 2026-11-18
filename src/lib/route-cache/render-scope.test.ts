import assert from "node:assert/strict";
import { test } from "node:test";
import { capRouteCacheTtl, type RenderScope, renderScope } from "./render-scope";

test("capRouteCacheTtl keeps the shortest lifetime any part of the render asked for", async () => {
  const scope: RenderScope = {};

  await renderScope.run(scope, async () => {
    capRouteCacheTtl(300);
    await new Promise((resolve) => setTimeout(resolve, 0));
    capRouteCacheTtl(60);
    capRouteCacheTtl(120);
  });

  assert.equal(scope.maxTtl, 60);
});

test("capRouteCacheTtl outside a render the route cache scoped is a no-op", () => {
  assert.doesNotThrow(() => capRouteCacheTtl(60));
  assert.equal(renderScope.getStore(), undefined);
});
