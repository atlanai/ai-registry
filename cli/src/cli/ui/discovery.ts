import type { Skill } from "#core/discovery/retrieval.ts";
import { type Discovery, safeError } from "#core/discovery/service.ts";
import { type PageReader, THIS_MACHINE } from "./page-state.ts";

/** Route-specific projection: no local paths, file content or auth context reaches Google. */
export async function discoveryRoute(
  service: Discovery,
  reader: PageReader,
  action: string,
  payload: Record<string, unknown>,
): Promise<[number, object]> {
  try {
    // Local controls remain available even when a registry cannot be reached.
    if (action === "stop") return [200, { ok: true, data: service.stop() }];
    if (action === "clear") return [200, { ok: true, data: await service.clear() }];
    if (action === "disconnect") return [200, { ok: true, data: await service.disconnect() }];
    if (action === "telemetry") return [200, { ok: true, data: await service.telemetry(payload) }];
    const page = await reader.read();
    const projected: Skill[] = page.artifacts
      .filter((s) => s.kind === "skill")
      .map((s) => ({
        key: s.key,
        name: s.name,
        registry: s.registry || THIS_MACHINE,
        namespace: s.namespace,
        description: s.description ?? "",
        version: s.version ?? "",
        digest: s.digest || s.diskDigest || "",
      }));
    const skills = [...new Map(projected.map((skill) => [skill.key, skill])).values()];
    let data: object;
    switch (action) {
      case "status":
        data = await service.status(skills);
        break;
      case "setup":
        data = await service.setup(payload, skills);
        break;
      case "index":
        data = await service.build(skills);
        break;
      case "search":
        data = await service.search(payload, skills);
        break;
      case "handoff":
        data = await service.handoff(payload, skills);
        break;
      case "feedback":
        data = await service.feedback(payload);
        break;
      default:
        return [404, { ok: false, error: "Unknown discovery action." }];
    }
    return [200, { ok: true, data }];
  } catch (error) {
    return [400, { ok: false, error: safeError(error) }];
  }
}
