import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { managedEndpointTunnelNamePrefix } from "../src/deploymentConfig.ts";
import {
  isPreviewStage,
  isPreviewTunnelName,
  isPreviewTunnelRecordName,
  tunnelCnameContent,
} from "../src/previewStages.ts";

// `alchemy destroy` removes the Worker and its custom domain. Managed endpoint
// tunnels and their CNAMEs are created at runtime, so Alchemy does not track
// them and they must be removed here. Dry run unless APPLY=true.

const API = "https://api.cloudflare.com/client/v4";
const PAGE_SIZE = 100;

const TunnelPage = Schema.Struct({
  result: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
});
const ZonePage = Schema.Struct({ result: Schema.Array(Schema.Struct({ id: Schema.String })) });
const DnsRecordPage = Schema.Struct({
  result: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      content: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});

const collectPages = <T, E, R>(
  fetchPage: (page: number) => Effect.Effect<ReadonlyArray<T>, E, R>,
) =>
  Effect.gen(function* () {
    const items: Array<T> = [];
    for (let page = 1; ; page += 1) {
      const batch = yield* fetchPage(page);
      items.push(...batch);
      if (batch.length < PAGE_SIZE) return items;
    }
  });

const main = Effect.gen(function* () {
  const stage = yield* Config.String("PREVIEW_STAGE");
  if (!isPreviewStage(stage)) {
    return yield* Effect.die(`Refusing to sweep non-preview stage '${stage}'`);
  }
  const apply = yield* Config.Boolean("APPLY").pipe(Config.withDefault(false));
  const accountId = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");
  const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");
  const tunnelZoneName = yield* Config.String("RELAY_TUNNEL_ZONE_NAME");
  const client = yield* HttpClient.HttpClient;

  const send = (request: HttpClientRequest.HttpClientRequest) =>
    request.pipe(
      HttpClientRequest.bearerToken(Redacted.value(token)),
      client.execute,
      Effect.flatMap(HttpClientResponse.filterStatusOk),
    );
  const getJson = <A, I>(url: string, params: Record<string, string>, schema: Schema.Codec<A, I>) =>
    send(HttpClientRequest.get(url, { urlParams: params })).pipe(
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
    );

  const tunnelPrefix = managedEndpointTunnelNamePrefix(stage);
  const tunnels = (yield* collectPages((page) =>
    getJson(
      `${API}/accounts/${accountId}/cfd_tunnel`,
      {
        is_deleted: "false",
        include_prefix: tunnelPrefix,
        per_page: String(PAGE_SIZE),
        page: String(page),
      },
      TunnelPage,
    ).pipe(Effect.map((body) => body.result)),
  )).filter((tunnel) => tunnel.name != null && isPreviewTunnelName(tunnel.name, stage));
  const tunnelIds = new Set(tunnels.map((tunnel) => tunnel.id));

  const zone = yield* getJson(`${API}/zones`, { name: tunnelZoneName }, ZonePage);
  const zoneId = zone.result[0]?.id;
  if (zoneId === undefined) {
    return yield* Effect.die(`No Cloudflare zone named ${tunnelZoneName}`);
  }
  const records = (yield* collectPages((page) =>
    getJson(
      `${API}/zones/${zoneId}/dns_records`,
      { type: "CNAME", per_page: String(PAGE_SIZE), page: String(page) },
      DnsRecordPage,
    ).pipe(Effect.map((body) => body.result)),
  )).filter(
    (record) =>
      isPreviewTunnelRecordName(record.name, stage, tunnelZoneName) &&
      [...tunnelIds].some((id) => record.content === tunnelCnameContent(id)),
  );

  yield* Console.log(
    `${apply ? "Deleting" : "Would delete"} ${tunnels.length} tunnel(s) and ${records.length} CNAME(s) for ${stage}`,
  );
  if (!apply) return;

  // Records first, so no hostname points at a tunnel that is about to vanish.
  for (const record of records) {
    yield* send(
      HttpClientRequest.make("DELETE")(`${API}/zones/${zoneId}/dns_records/${record.id}`),
    );
  }
  // Cloudflare refuses to delete a tunnel that still has connectors attached.
  for (const tunnel of tunnels) {
    yield* send(
      HttpClientRequest.make("DELETE")(
        `${API}/accounts/${accountId}/cfd_tunnel/${tunnel.id}/connections`,
      ),
    );
    yield* send(
      HttpClientRequest.make("DELETE")(`${API}/accounts/${accountId}/cfd_tunnel/${tunnel.id}`),
    );
  }
  yield* Console.log(`Swept ${stage}`);
}).pipe(Effect.provide(FetchHttpClient.layer));

NodeRuntime.runMain(main);
