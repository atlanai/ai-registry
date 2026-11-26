import { credentialForLocation } from "#accounts/credentials.ts";
import type { RegistryIdentity } from "#adapter/index.ts";
import { connectSource, resolveArtifacts } from "#core/adapter/connect.ts";
import { declaredLayout } from "#core/adapter/load.ts";
import type { SeenRegistry } from "./model.ts";

/**
 * What a registry says about itself now, its usage endpoint included, read from its
 * `registry.json` as an install would read it. Asks for no artifacts.
 */
export async function identityOf(registry: SeenRegistry): Promise<RegistryIdentity | undefined> {
  const source = { adapter: registry.adapter, config: registry.config };
  const credential = await credentialForLocation(registry.location, registry.alias, source);
  const open = await connectSource(
    {
      alias: registry.alias,
      location: registry.location,
      adapter: registry.adapter,
      config: registry.config,
      layout: declaredLayout(registry.config),
    },
    credential === undefined ? {} : { credential },
  );
  try {
    return (await resolveArtifacts(open, [])).registry;
  } finally {
    await open.handle.close();
  }
}
