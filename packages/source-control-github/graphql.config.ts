import { defineConfig } from "@effect/graphql-generator/Config";

// Uses github.com's public schema (https://docs.github.com/public/fpt/schema.docs.graphql). Gate
// fields missing on Enterprise Server with @include.
export default defineConfig({
  schema: "./schema/github.graphql",
  documents: ["src/**/*.graphql"],
  scalars: {
    GitObjectID: "effect/Schema#String",
    GitRefname: "effect/Schema#String",
    // Kept as GitHub sends it: callers compare these strings with other reads of the same field.
    DateTime: "effect/Schema#String",
  },
});
