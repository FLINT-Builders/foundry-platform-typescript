/*
 * Copyright 2026 Palantir Technologies, Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, it } from "vitest";
import {
  deleteUser,
  get as getUser,
  revokeAllTokens,
} from "../../foundry.admin/src/v2/public/User.js";
import { replace as replaceFolder } from "../../foundry.filesystem/src/v2/public/Folder.js";
import { apply as applyAction } from "../../foundry.ontologies/src/v2/public/Action.js";
import { getLinkedObject } from "../../foundry.ontologies/src/v2/public/LinkedObjectV2.js";
import {
  count as countObjects,
  get as getObject,
  list as listObjects,
} from "../../foundry.ontologies/src/v2/public/OntologyObjectV2.js";
import { load as loadMap } from "../../gotham.gaia/src/v2/public/Map.js";
import { getLinkedObject as getLinkedObjectInternal } from "../../internal.foundry.ontologiesv2/src/public/LinkedObjectV2.js";
import type { FoundryPlatformMethod } from "../src/foundryPlatformFetch.js";
import { foundryPlatformFetch } from "../src/foundryPlatformFetch.js";

const PLACEHOLDER_SERVICE_TOKEN = "placeholder-service-token";
const LISTING = {
  data: [{ __primaryKey: "s-1", objectType: "SalaryRecord" }],
  nextPageToken: undefined,
};

/**
 * Segment values the URL parser treats as dot segments, including the
 * percent-encoded spellings, plus an empty segment. A value is dangerous
 * when the whole segment is one or two dots after the parser's percent-decode.
 */
const REJECTED_PATH_PARAMETERS = [
  ".",
  "..",
  "",
  "%2e",
  "%2E",
  "%2e%2e",
  "%2E%2E",
  ".%2E",
  "%2e.",
  ".%2e",
  "%2E.",
];

const ACCEPTED_PATH_PARAMETERS = [
  "proj-1",
  "a.b",
  "a..b",
  "..salary",
  "salary..",
  "a/b",
  "ontology/with space",
  "%2e%2e%2e",
];

interface CapturedRequest {
  url: string;
  method: string;
  authorization: string | null;
  body: string | null;
}

interface RecordingClient {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  tokenProvider: () => Promise<string>;
}

function createRecordingClient(
  records: CapturedRequest[],
  responseBody: unknown = LISTING,
): RecordingClient {
  const tokenProvider = async () => PLACEHOLDER_SERVICE_TOKEN;
  return {
    baseUrl: "https://foundry.example",
    tokenProvider,
    fetch: async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set(
        "Authorization",
        `Bearer ${await tokenProvider()}`,
      );
      const url = input instanceof Request ? input.url : String(input);
      const method = init?.method
        ?? (input instanceof Request ? input.method : "GET");
      records.push({
        url,
        method,
        authorization: headers.get("Authorization"),
        body: typeof init?.body === "string" ? init.body : null,
      });
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

async function settle(run: () => Promise<unknown>): Promise<
  | { kind: "returned"; value: unknown }
  | { kind: "thrown" }
> {
  try {
    return { kind: "returned", value: await run() };
  } catch {
    return { kind: "thrown" };
  }
}

function expectRefused(
  records: CapturedRequest[],
  outcome: { kind: string; value?: unknown },
) {
  expect({ requests: records, result: outcome }).toEqual({
    requests: [],
    result: { kind: "thrown" },
  });
}

describe("path parameters that normalize to a different route", () => {
  it.each(REJECTED_PATH_PARAMETERS)(
    "getLinkedObject refuses primary key %j before sending",
    async (primaryKey) => {
      const records: CapturedRequest[] = [];
      const client = createRecordingClient(records);
      const outcome = await settle(() =>
        getLinkedObject(
          client,
          "ont",
          "Project",
          primaryKey,
          "owner",
          "salary-1",
          { select: ["name"] },
        )
      );
      expectRefused(records, outcome);
    },
  );

  it.each(REJECTED_PATH_PARAMETERS)(
    "getLinkedObject refuses link type %j before sending",
    async (linkType) => {
      const records: CapturedRequest[] = [];
      const client = createRecordingClient(records);
      const outcome = await settle(() =>
        getLinkedObject(
          client,
          "ont",
          "Project",
          "proj-1",
          linkType,
          "salary-1",
          { select: ["name"] },
        )
      );
      expectRefused(records, outcome);
    },
  );

  it.each(REJECTED_PATH_PARAMETERS)(
    "getLinkedObject refuses linked primary key %j before sending",
    async (linkedPk) => {
      const records: CapturedRequest[] = [];
      const client = createRecordingClient(records);
      const outcome = await settle(() =>
        getLinkedObject(
          client,
          "ont",
          "Project",
          "proj-1",
          "owner",
          linkedPk,
          { select: ["name"] },
        )
      );
      expectRefused(records, outcome);
    },
  );

  it(
    "two dot segments turn a linked-object get into a list of another type",
    async () => {
      const records: CapturedRequest[] = [];
      const client = createRecordingClient(records);
      const outcome = await settle(() =>
        getLinkedObject(
          client,
          "ont",
          "Project",
          "..",
          "..",
          "SalaryRecord",
          { select: ["name"] },
        )
      );
      expectRefused(records, outcome);
    },
  );

  it("the internal linked-object helper uses the same refusal", async () => {
    const records: CapturedRequest[] = [];
    const client = createRecordingClient(records);
    const outcome = await settle(() =>
      getLinkedObjectInternal(
        client,
        "ont",
        "Project",
        "..",
        "..",
        "SalaryRecord",
        { select: ["name"] },
      )
    );
    expectRefused(records, outcome);
  });

  it.each(REJECTED_PATH_PARAMETERS)(
    "object get refuses primary key %j before sending",
    async (primaryKey) => {
      const records: CapturedRequest[] = [];
      const client = createRecordingClient(records);
      const outcome = await settle(() =>
        getObject(client, "ont", "Project", primaryKey, { select: ["name"] })
      );
      expectRefused(records, outcome);
    },
  );

  it.each(REJECTED_PATH_PARAMETERS)(
    "object list refuses object type %j before sending",
    async (objectType) => {
      const records: CapturedRequest[] = [];
      const client = createRecordingClient(records);
      const outcome = await settle(() =>
        listObjects(client, "ont", objectType, { select: ["name"] })
      );
      expectRefused(records, outcome);
    },
  );

  it.each(REJECTED_PATH_PARAMETERS)(
    "object count refuses object type %j before sending",
    async (objectType) => {
      const records: CapturedRequest[] = [];
      const client = createRecordingClient(records);
      const outcome = await settle(() =>
        countObjects(client, "ont", objectType)
      );
      expectRefused(records, outcome);
    },
  );

  it.each(REJECTED_PATH_PARAMETERS)(
    "deleteUser refuses user id %j before sending",
    async (userId) => {
      const records: CapturedRequest[] = [];
      const client = createRecordingClient(records);
      const outcome = await settle(() => deleteUser(client, userId));
      expectRefused(records, outcome);
    },
  );

  it.each(REJECTED_PATH_PARAMETERS)(
    "get user refuses user id %j before sending",
    async (userId) => {
      const records: CapturedRequest[] = [];
      const client = createRecordingClient(records);
      const outcome = await settle(() => getUser(client, userId));
      expectRefused(records, outcome);
    },
  );

  it.each(REJECTED_PATH_PARAMETERS)(
    "revokeAllTokens refuses user id %j before sending",
    async (userId) => {
      const records: CapturedRequest[] = [];
      const client = createRecordingClient(records);
      const outcome = await settle(() => revokeAllTokens(client, userId));
      expectRefused(records, outcome);
    },
  );

  it.each(REJECTED_PATH_PARAMETERS)(
    "folder replace refuses folder rid %j before sending the body",
    async (folderRid) => {
      const records: CapturedRequest[] = [];
      const client = createRecordingClient(records);
      const outcome = await settle(() =>
        replaceFolder(client, folderRid, { displayName: "renamed" })
      );
      expectRefused(records, outcome);
    },
  );

  it.each(REJECTED_PATH_PARAMETERS)(
    "apply action refuses action name %j before sending the body",
    async (action) => {
      const records: CapturedRequest[] = [];
      const client = createRecordingClient(records);
      const outcome = await settle(() =>
        applyAction(client, "ont", action, { parameters: { id: "record-1" } })
      );
      expectRefused(records, outcome);
    },
  );

  it.each(REJECTED_PATH_PARAMETERS)(
    "gaia map load refuses map rid %j before sending",
    async (mapRid) => {
      const records: CapturedRequest[] = [];
      const client = createRecordingClient(records);
      const outcome = await settle(() => loadMap(client, mapRid));
      expectRefused(records, outcome);
    },
  );

  it.each([0, 1, 2, 3, 4])(
    "foundryPlatformFetch method %i refuses a dot-segment parameter",
    async (method) => {
      const records: CapturedRequest[] = [];
      const client = createRecordingClient(records);
      const operation = [
        method,
        "/v2/resources/{0}/child",
        1,
      ] as FoundryPlatformMethod<
        (id: string, body: { n: number }) => Promise<unknown>
      >;
      const outcome = await settle(() =>
        foundryPlatformFetch(client, operation, "..", { n: 1 })
      );
      expectRefused(records, outcome);
    },
  );

  it("refuses a dot segment supplied through the legacy client context", async () => {
    const records: CapturedRequest[] = [];
    const client = createRecordingClient(records);
    const operation = [
      0,
      "/v2/ontologies/{0}/objects/{1}/{2}/links/{3}/{4}",
      2,
    ] as FoundryPlatformMethod<
      (
        ontology: string,
        objectType: string,
        primaryKey: string,
        linkType: string,
        linkedPk: string,
        query: { select: string[] },
      ) => Promise<unknown>
    >;
    const outcome = await settle(() =>
      foundryPlatformFetch(
        client,
        operation,
        "ont",
        "Project",
        "..",
        "..",
        "SalaryRecord",
        { select: ["name"] },
      )
    );
    expectRefused(records, outcome);
  });
});

describe("ordinary path parameters stay on the route the caller named", () => {
  it.each(ACCEPTED_PATH_PARAMETERS)(
    "getLinkedObject keeps %j inside one segment",
    async (primaryKey) => {
      const records: CapturedRequest[] = [];
      const client = createRecordingClient(records);
      const value = await getLinkedObject(
        client,
        "ont",
        "Project",
        primaryKey,
        "owner",
        "salary-1",
        { select: ["name"] },
      );
      expect(value).toEqual(LISTING);
      expect(records).toHaveLength(1);
      const [request] = records;
      const url = new URL(request.url);
      expect(request.method).toBe("GET");
      expect(request.authorization).toBe(
        `Bearer ${PLACEHOLDER_SERVICE_TOKEN}`,
      );
      expect(url.pathname).toBe(
        "/api/v2/ontologies/ont/objects/Project/"
          + `${encodeURIComponent(primaryKey)}/links/owner/salary-1`,
      );
      expect(url.searchParams.get("select")).toBe("name");
    },
  );

  it("encodes a slash in an object type as part of that segment", async () => {
    const records: CapturedRequest[] = [];
    const client = createRecordingClient(records);
    await listObjects(client, "ont", "Salary/Record", { select: ["name"] });
    const url = new URL(records[0].url);
    expect(url.pathname).toBe(
      "/api/v2/ontologies/ont/objects/Salary%2FRecord",
    );
    expect(records[0].method).toBe("GET");
  });

  it("sends a folder replace body only to the folder route", async () => {
    const records: CapturedRequest[] = [];
    const client = createRecordingClient(records, { rid: "ri.folder.1" });
    await replaceFolder(client, "ri.folder.1", { displayName: "renamed" });
    const url = new URL(records[0].url);
    expect(records[0].method).toBe("PUT");
    expect(url.pathname).toBe("/api/v2/filesystem/folders/ri.folder.1");
    expect(records[0].body).toBe(
      JSON.stringify({ displayName: "renamed" }),
    );
    expect(records[0].authorization).toBe(
      `Bearer ${PLACEHOLDER_SERVICE_TOKEN}`,
    );
  });
});
