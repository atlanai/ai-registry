import type { ArtifactKind } from "#adapter/kinds.ts";
import type { Installed, Watched } from "#cli/render/installed.ts";
import type { LinkMode } from "#core/lock.ts";
import type { Scope } from "#core/store/paths.ts";

/** Everything installed, or with a name, the detail of that one. */
export type ListResult = Listing | Detail;

interface Listing {
  scope: Scope;
  artifacts: Listed[];
}

/** `harnesses` repeats `targets` by the ids aireg 0.1 used. */
interface Listed extends Installed {
  harnesses: string[];
}

/** One installed artifact, read from the lockfile alone. */
interface Detail {
  /** As the command line named it. */
  name: string;
  kind: ArtifactKind;
  registry: string;
  address?: string;
  adapter?: string;
  registryKey?: string;
  config?: Record<string, string>;
  revision?: string;
  id?: string;
  upstreamName: string;
  content?: string;
  version?: string;
  path: string;
  /** The stored copy every link leads to, relative to the scope. */
  copy: string;
  watched?: Watched;
  links: Link[];
  neededBy?: string[];
}

interface Link {
  target: string;
  path: string;
  mode: LinkMode;
  digest?: string;
  /** `target` by the id aireg 0.1 used. */
  harness: string;
}
