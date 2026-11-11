import type { ChannelAdapter, ChannelId } from "@repo/core";

/**
 * The channel adapters of this deployment, by channel. `apps/web/src/server` registers them
 * (C3 the test channel, C8 to C11 the real ones); the pipeline only looks them up.
 */
export interface AdapterRegistry {
  register(adapter: ChannelAdapter): void;
  find(channel: ChannelId): ChannelAdapter | undefined;
  channels(): ChannelId[];
}

export function createAdapterRegistry(adapters: readonly ChannelAdapter[] = []): AdapterRegistry {
  const byChannel = new Map<ChannelId, ChannelAdapter>();
  const registry: AdapterRegistry = {
    register(adapter) {
      if (byChannel.has(adapter.channel)) {
        throw new Error(`An adapter for the ${adapter.channel} channel is already registered.`);
      }
      byChannel.set(adapter.channel, adapter);
    },
    find: (channel) => byChannel.get(channel),
    channels: () => [...byChannel.keys()],
  };
  for (const adapter of adapters) registry.register(adapter);
  return registry;
}
