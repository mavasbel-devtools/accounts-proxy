// The daemon's start-up fetch of the model lists (plan 2026-10-28-13-40 M2): every kept list at once. A list that reads
// the reference catalog (OpenCode, OpenAI) joins the reference fetch already running instead of starting another.
import { WarmModelsPort } from "@accounts-proxy/core/ports/inbound/routing.ts";
import type { ModelListCachePort } from "@accounts-proxy/core/ports/outbound/model-list-cache.ts";

export class WarmModelsService extends WarmModelsPort {
  constructor(private readonly lists: readonly ModelListCachePort<unknown>[]) {
    super();
  }

  async warm(): Promise<void> {
    await Promise.allSettled(this.lists.map((list) => list.fetch("start")));
  }
}
