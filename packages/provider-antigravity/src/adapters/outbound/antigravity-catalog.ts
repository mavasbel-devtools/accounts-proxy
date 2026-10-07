// Live model catalog (`fetchAvailableModels`). Source ResolveModelsUseCase: no static list; descriptors exclude
// tab/deprecated models (law 9); the per-request envelope defaults are memoized per process ("the relay memoizes
// this map per process"). Router addition: a memo miss for a requested id triggers one refetch, so a model added
// upstream after start-up is usable without restarting the daemon.
import type { LoggerPort } from "@inference-router/core/ports/outbound/system.ts";
import { toModelDescriptors, type ModelDescriptor } from "../../domain/catalog.ts";
import { AntigravityCatalogPort, type AntigravityApiPort, type AntigravitySessionPort } from "../../ports/outbound/antigravity.ts";
import { withActive } from "./with-active.ts";

export class AntigravityCatalog extends AntigravityCatalogPort {
  private memo: readonly ModelDescriptor[] | undefined;

  constructor(
    private readonly api: AntigravityApiPort,
    private readonly session: AntigravitySessionPort,
    private readonly logger: LoggerPort,
  ) {
    super();
  }

  async descriptors(): Promise<readonly ModelDescriptor[]> {
    const { id, raw } = await withActive(this.session, async (active) => ({ id: active.id, raw: await this.api.fetchAvailableModels(active.account.tokens) }));
    const descriptors = toModelDescriptors(raw);
    this.memo = descriptors;
    this.logger.info(`antigravity: resolved ${descriptors.length} models for ${id}`);
    return descriptors;
  }

  async descriptor(wireId: string): Promise<ModelDescriptor | undefined> {
    const find = (list: readonly ModelDescriptor[] | undefined) => list?.find((d) => d.wireId === wireId);
    return find(this.memo) ?? find(await this.descriptors());
  }
}
