import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  EnvironmentId,
  ProjectId,
  type PullRequestFilterOptionKind,
  type PullRequestFilterOptionsInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useState } from "react";
import { FlatList, Platform, Pressable, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { EmptyState } from "../../components/ui/EmptyState";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { composerPullRequests } from "../../state/pull-requests";
import { useDebouncedValue } from "../../state/queries";
import { pullRequestFilterChoices } from "./pullRequestList";
import { usePullRequestListControls } from "./usePullRequestListControls";

export type PullRequestFilterSearchParams = {
  readonly kind: PullRequestFilterOptionKind;
  /** The list controls' own key: the environment the list is narrowed to, or every one. */
  readonly environmentId: string | null;
  /** The environments the list reads, which the host search covers as well. */
  readonly environmentIds: readonly string[];
  /** What the loaded rows already carry, offered before the host has answered. */
  readonly suggestions: readonly string[];
};

const optionsFamily = Atom.family((key: string) => {
  const targets: readonly {
    readonly environmentId: EnvironmentId;
    readonly input: PullRequestFilterOptionsInput;
  }[] = JSON.parse(key);
  return Atom.make((get) => {
    const results = targets.map((target) => get(composerPullRequests.filterOptions(target)));
    return {
      values: results.flatMap((result) => Option.toArray(AsyncResult.value(result))),
      waiting: results.some((result) => result.waiting),
    };
  });
});

export function PullRequestFilterSearchScreen({
  route,
}: StaticScreenProps<PullRequestFilterSearchParams>) {
  const navigation = useNavigation();
  const { kind, environmentId, environmentIds, suggestions } = route.params;
  const listControls = usePullRequestListControls();
  const controls = listControls.controlsFor(environmentId);
  const [query, setQuery] = useState("");
  const sent = useDebouncedValue(query.trim().slice(0, 100), 250);
  const key = JSON.stringify(
    environmentIds.map((id) => ({
      environmentId: EnvironmentId.make(id),
      input: {
        kind,
        ...(controls.projectId ? { projectId: ProjectId.make(controls.projectId) } : {}),
        ...(sent ? { query: sent } : {}),
      },
    })),
  );
  const hosted = useAtomValue(optionsFamily(key));
  const selectedLabels = controls.filters.labels?.flat() ?? [];
  const author = controls.filters.author;
  const selected = kind === "labels" ? selectedLabels : author ? [author] : [];
  const rows = pullRequestFilterChoices({
    selected,
    suggestions,
    hosted: hosted.values.flatMap((options) =>
      kind === "labels"
        ? options.labels.map((label) => label.name)
        : options.authors.map((candidate) => candidate.login),
    ),
    query,
  });
  const isSelected = (value: string) =>
    selected.some((held) => held.toLowerCase() === value.toLowerCase());
  const choose = (value: string) => {
    if (kind === "authors") {
      listControls.setControls(environmentId, {
        ...controls,
        filters: { ...controls.filters, author: isSelected(value) ? undefined : value },
      });
      navigation.goBack();
      return;
    }
    const labels = isSelected(value)
      ? selectedLabels.filter((label) => label.toLowerCase() !== value.toLowerCase())
      : [...selectedLabels, value].slice(0, 10);
    listControls.setControls(environmentId, {
      ...controls,
      filters: {
        ...controls.filters,
        labels: labels.length ? labels.map((label) => [label]) : undefined,
      },
    });
  };
  const placeholder = kind === "labels" ? "Search labels" : "Search authors";
  return (
    <View className="flex-1 bg-sheet">
      <SheetHeader
        title={kind === "labels" ? "Filter by label" : "Filter by author"}
        onClose={() => navigation.goBack()}
        accessibilityLabel={kind === "labels" ? "Close label filter" : "Close author filter"}
      />
      <NativeStackScreenOptions
        options={{
          headerSearchBarOptions:
            Platform.OS === "ios"
              ? {
                  placeholder,
                  autoCapitalize: "none",
                  onChangeText: (event) => setQuery(event.nativeEvent.text),
                  onCancelButtonPress: () => setQuery(""),
                  hideNavigationBar: false,
                  hideWhenScrolling: false,
                  obscureBackground: false,
                  placement: "stacked",
                }
              : undefined,
        }}
      />
      <FlatList
        data={rows}
        keyExtractor={(value) => value.toLowerCase()}
        contentInsetAdjustmentBehavior="automatic"
        automaticallyAdjustKeyboardInsets
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: 24 }}
        ListHeaderComponent={
          Platform.OS === "android" ? (
            <View className="px-4 py-4">
              <TextInput
                accessibilityLabel={placeholder}
                placeholder={placeholder}
                placeholderTextColorClassName="accent-foreground-muted"
                value={query}
                onChangeText={setQuery}
                autoCapitalize="none"
                autoCorrect={false}
                className="min-h-11 rounded-xl bg-grouped-card px-3 text-sm"
              />
            </View>
          ) : undefined
        }
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: isSelected(item) }}
            accessibilityLabel={item}
            onPress={() => choose(item)}
            className="min-h-12 flex-row items-center gap-3 border-b border-border-subtle px-4 py-3 active:opacity-70"
          >
            <Text className="min-w-0 flex-1 text-sm" numberOfLines={1}>
              {item}
            </Text>
            {isSelected(item) ? (
              <SymbolView name="checkmark" size={14} tintColorClassName="accent-icon" />
            ) : null}
          </Pressable>
        )}
        ListEmptyComponent={
          hosted.waiting ? (
            <AppActivityIndicator className="my-8" />
          ) : (
            <View className="px-4 py-6">
              <EmptyState
                title={kind === "labels" ? "No matching labels" : "No matching authors"}
                detail={
                  kind === "labels"
                    ? "Search the labels of the repositories this list covers."
                    : "Search people by name or handle on the repositories' hosts."
                }
                variant="plain"
              />
            </View>
          )
        }
      />
    </View>
  );
}
