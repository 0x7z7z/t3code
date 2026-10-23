import type { ServerProviderModel } from "@t3tools/contracts";

export function selectEditingWorkspace<
  T extends { readonly id: string; readonly environmentId: string },
>(projects: ReadonlyArray<T>, key: string | null): T | null {
  return key === null
    ? (projects[0] ?? null)
    : (projects.find((project) => `${project.environmentId}:${project.id}` === key) ?? null);
}

export function selectEditingProvider<
  T extends { readonly instanceId: string; readonly enabled: boolean; readonly installed: boolean },
>(providers: ReadonlyArray<T>, key: string | null): T | null {
  return (
    providers.find(
      (provider) =>
        (key === null || provider.instanceId === key) && provider.enabled && provider.installed,
    ) ?? null
  );
}

export function selectEditingModel(
  models: ReadonlyArray<ServerProviderModel>,
  key: string | null,
): ServerProviderModel | null {
  if (key !== null) return models.find((model) => model.slug === key) ?? null;
  return (
    models.find((model) => /gpt-6[.-]luna/i.test(model.slug)) ??
    models.find((model) => model.isDefault) ??
    models[0] ??
    null
  );
}
