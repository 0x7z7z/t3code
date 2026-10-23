import type { ProviderOptionSelection, ServerProviderModel } from "@t3tools/contracts";

export function editingModelOptions(
  model: ServerProviderModel,
  values: Readonly<Record<string, string | boolean>>,
): ProviderOptionSelection[] {
  return (model.capabilities?.optionDescriptors ?? []).flatMap<ProviderOptionSelection>(
    (descriptor) => {
      const selected = values[descriptor.id];
      if (descriptor.type === "boolean")
        return [
          {
            id: descriptor.id,
            value: typeof selected === "boolean" ? selected : (descriptor.currentValue ?? false),
          },
        ];
      const allowed = (value: unknown): value is string =>
        typeof value === "string" && descriptor.options.some((choice) => choice.id === value);
      const preferred =
        /gpt-6[.-]luna/i.test(model.slug) &&
        /effort|reasoning/i.test(descriptor.id) &&
        allowed("max")
          ? "max"
          : descriptor.currentValue;
      const value = allowed(selected)
        ? selected
        : allowed(preferred)
          ? preferred
          : (descriptor.options.find((choice) => choice.isDefault)?.id ??
            descriptor.options[0]?.id);
      return value ? [{ id: descriptor.id, value }] : [];
    },
  );
}
