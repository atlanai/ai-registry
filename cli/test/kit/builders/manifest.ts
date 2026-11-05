import type { SourceConfig } from "#core/adapter/identity.ts";
import { formatManifest } from "#core/manifest/format.ts";
import { emptyManifest, type Manifest } from "#core/manifest/model.ts";
import { parseRef } from "#core/ref.ts";
import { manifestPath, writeManifestIn } from "#test/kit/scope.ts";

/** A scope's manifest, built as the parsed object and written with aireg's own formatter. */
class ManifestBuilder {
  readonly #manifest: Manifest = emptyManifest();

  registry(
    alias: string,
    location: string,
    options: { adapter?: string; config?: SourceConfig } = {},
  ): this {
    this.#manifest.registries[alias] = {
      location,
      adapter: options.adapter,
      config: options.config ?? {},
    };
    return this;
  }

  /** Each a reference as a manifest writes it, such as `kit/skill/lint@1.0.0`. */
  artifacts(...refs: string[]): this {
    this.#manifest.artifacts.push(...refs.map(parseRef));
    return this;
  }

  targets(...names: string[]): this {
    this.#manifest.targets.push(...names);
    return this;
  }

  build(): Manifest {
    return structuredClone(this.#manifest);
  }

  text(): string {
    return formatManifest(this.#manifest);
  }

  /** Into `<dir>/.registry/manifest.yml`, returning that path. */
  async write(dir: string): Promise<string> {
    await writeManifestIn(dir, this.text());
    return manifestPath(dir);
  }
}

export function manifest(): ManifestBuilder {
  return new ManifestBuilder();
}
