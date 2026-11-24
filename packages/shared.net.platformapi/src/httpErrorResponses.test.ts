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

import { symbolClientContext as oldSymbolClientContext } from "@osdk/shared.client";
import { symbolClientContext } from "@osdk/shared.client2";
import type { SharedClient, SharedClientContext } from "@osdk/shared.client2";
import { PalantirApiError, UnknownError } from "@osdk/shared.net.errors";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { replace as replaceGroup } from "../../foundry.admin/src/v2/public/Group.ts";
import { remove as removeMarkingMembers } from "../../foundry.admin/src/v2/public/MarkingMember.ts";
import {
  content as readAuditLog,
  list as listAuditLogs,
} from "../../foundry.audit/src/v2/public/LogFile.ts";
import {
  content as readDatasetFile,
  deleteFile,
  get as getDatasetFile,
} from "../../foundry.datasets/src/v2/public/File.ts";
import {
  deleteResource,
  removeMarkings,
} from "../../foundry.filesystem/src/v2/public/Resource.ts";
import { streamingExecuteEvents } from "../../foundry.functions/src/v2/public/Query.ts";

/**
 * Spec for HTTP error handling in foundryPlatformFetch.
 *
 * These tests fail while a non-OK response is returned as a fulfilled
 * value. They pass once that error is thrown.
 */

const jsonError = {
  errorCode: "PERMISSION_DENIED",
  errorName: "PermissionDenied",
  errorInstanceId: "error-instance-placeholder",
  parameters: { resource: "ri.resource.1" },
  errorDescription: "The caller cannot perform this operation.",
  message: "The caller cannot perform this operation.",
};

interface RecordedRequest {
  method: string | undefined;
  url: string | undefined;
  body: string;
  accept: string | undefined;
}

interface ClientEnv {
  baseUrl: string;
  requests: RecordedRequest[];
  statuses: boolean[];
  context: SharedClientContext;
  client: SharedClient;
  oldClient: { [oldSymbolClientContext]: SharedClientContext };
}

const openServers: Array<() => Promise<void>> = [];

afterEach(async () => {
  const closers = openServers.splice(0);
  await Promise.all(closers.map((close) => close()));
});

function contextFor(baseUrl: string, statuses: boolean[]): SharedClientContext {
  return {
    baseUrl,
    fetch: async (input, init) => {
      const response = await globalThis.fetch(input, init);
      statuses.push(response.ok);
      return response;
    },
    tokenProvider: async () => "placeholder-token",
  };
}

async function listen(
  respond: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<ClientEnv> {
  const requests: RecordedRequest[] = [];
  const statuses: boolean[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    requests.push({
      method: req.method,
      url: req.url,
      body: Buffer.concat(chunks).toString("utf8"),
      accept: req.headers.accept,
    });
    respond(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  openServers.push(() =>
    new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    })
  );
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const context = contextFor(baseUrl, statuses);
  return {
    baseUrl,
    requests,
    statuses,
    context,
    client: { [symbolClientContext]: context },
    oldClient: { [oldSymbolClientContext]: context },
  };
}

function jsonResponse(status: number, body: unknown) {
  return (_req: IncomingMessage, res: ServerResponse) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  };
}

function textResponse(status: number, body: string, contentType: string) {
  return (_req: IncomingMessage, res: ServerResponse) => {
    res.statusCode = status;
    res.setHeader("content-type", contentType);
    res.end(body);
  };
}

async function responseJsonMessage(
  body: string,
  contentType: string,
): Promise<string> {
  try {
    await new Response(body, {
      status: 500,
      headers: { "content-type": contentType },
    }).json();
  } catch (error) {
    if (error instanceof Error) {
      return error.message;
    }
  }
  throw new Error("Response.json accepted a non-JSON body");
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function asCaller<T>(run: () => Promise<T>): Promise<Outcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, error };
  }
}

function expectRejectedApiError(
  outcome: Outcome<unknown>,
  fields: Record<string, unknown>,
) {
  expect(outcome).toEqual({
    ok: false,
    error: expect.any(PalantirApiError),
  });
  if (outcome.ok) {
    return;
  }
  expect(Object.getPrototypeOf(outcome.error)).toBe(
    PalantirApiError.prototype,
  );
  expect(outcome.error).toMatchObject(fields);
}

function expectRejectedUnknownError(
  outcome: Outcome<unknown>,
  fields: Record<string, unknown>,
) {
  expect(outcome).toEqual({
    ok: false,
    error: expect.any(UnknownError),
  });
  if (outcome.ok) {
    return;
  }
  expect(outcome.error).toMatchObject(fields);
}

describe("generated methods reject HTTP error responses", () => {
  it("rejects a JSON 403 from dataset file delete", async () => {
    const env = await listen(jsonResponse(403, jsonError));
    const outcome = await asCaller(() =>
      deleteFile(env.client, "ri.dataset.1", "secret.txt", {
        branchName: "main",
      })
    );

    expect(env.statuses).toEqual([false]);
    expect(env.requests).toEqual([
      {
        method: "DELETE",
        url: "/api/v2/datasets/ri.dataset.1/files/secret.txt?branchName=main",
        body: "",
        accept: "application/json",
      },
    ]);
    expectRejectedApiError(outcome, {
      ...jsonError,
      statusCode: 403,
    });
  });

  it("rejects a JSON 404 from an audit log read", async () => {
    const env = await listen(jsonResponse(404, {
      ...jsonError,
      errorCode: "NOT_FOUND",
      errorName: "LogFileNotFound",
    }));
    const outcome = await asCaller(() =>
      readAuditLog(env.context, "ri.org.1", "log-1")
    );

    expect(env.statuses).toEqual([false]);
    expect(env.requests[0]?.method).toBe("GET");
    expect(env.requests[0]?.url).toBe(
      "/api/v2/audit/organizations/ri.org.1/logFiles/log-1/content",
    );
    expect(env.requests[0]?.accept).toBe("application/octet-stream");
    expectRejectedApiError(outcome, {
      errorCode: "NOT_FOUND",
      errorName: "LogFileNotFound",
      statusCode: 404,
    });
  });

  it("rejects a JSON 500 from an audit log listing", async () => {
    const env = await listen(jsonResponse(500, {
      ...jsonError,
      errorCode: "INTERNAL",
      errorName: "Internal",
    }));
    const outcome = await asCaller(() =>
      listAuditLogs(env.oldClient, "ri.org.1", { pageSize: 10 })
    );

    expect(env.statuses).toEqual([false]);
    expect(env.requests[0]?.method).toBe("GET");
    expect(env.requests[0]?.url).toBe(
      "/api/v2/audit/organizations/ri.org.1/logFiles?pageSize=10",
    );
    expectRejectedApiError(outcome, {
      errorCode: "INTERNAL",
      errorName: "Internal",
      statusCode: 500,
    });
  });

  it("rejects a JSON 400 from a dataset file metadata read", async () => {
    const env = await listen(jsonResponse(400, {
      ...jsonError,
      errorCode: "INVALID_ARGUMENT",
      errorName: "InvalidFilePath",
    }));
    const outcome = await asCaller(() =>
      getDatasetFile(env.context, "ri.dataset.1", "notes.txt")
    );

    expect(env.statuses).toEqual([false]);
    expect(env.requests[0]?.method).toBe("GET");
    expect(env.requests[0]?.url).toBe(
      "/api/v2/datasets/ri.dataset.1/files/notes.txt",
    );
    expectRejectedApiError(outcome, {
      errorCode: "INVALID_ARGUMENT",
      errorName: "InvalidFilePath",
      statusCode: 400,
    });
  });

  it("rejects a JSON 403 from marking member removal", async () => {
    const env = await listen(jsonResponse(403, jsonError));
    const body = { principalIds: ["ri.principal.1"] };
    const outcome = await asCaller(() =>
      removeMarkingMembers(env.client, "ri.marking.1", body)
    );

    expect(env.statuses).toEqual([false]);
    expect(env.requests).toEqual([
      {
        method: "POST",
        url: "/api/v2/admin/markings/ri.marking.1/markingMembers/remove",
        body: JSON.stringify(body),
        accept: "application/json",
      },
    ]);
    expectRejectedApiError(outcome, { ...jsonError, statusCode: 403 });
  });

  it("rejects a JSON 403 from resource marking removal", async () => {
    const env = await listen(jsonResponse(403, jsonError));
    const body = { markingIds: ["ri.marking.1"] };
    const outcome = await asCaller(() =>
      removeMarkings(env.context, "ri.resource.1", body)
    );

    expect(env.statuses).toEqual([false]);
    expect(env.requests[0]?.method).toBe("POST");
    expect(env.requests[0]?.url).toBe(
      "/api/v2/filesystem/resources/ri.resource.1/removeMarkings",
    );
    expect(env.requests[0]?.body).toBe(JSON.stringify(body));
    expectRejectedApiError(outcome, { ...jsonError, statusCode: 403 });
  });

  it("rejects a JSON 409 from a group replace", async () => {
    const env = await listen(jsonResponse(409, {
      ...jsonError,
      errorCode: "CONFLICT",
      errorName: "GroupConflict",
    }));
    const body = { name: "renamed", description: "updated" };
    const outcome = await asCaller(() =>
      replaceGroup(env.context, "ri.group.1", body as never)
    );

    expect(env.statuses).toEqual([false]);
    expect(env.requests[0]?.method).toBe("PUT");
    expect(env.requests[0]?.url).toBe("/api/v2/admin/groups/ri.group.1");
    expect(env.requests[0]?.body).toBe(JSON.stringify(body));
    expectRejectedApiError(outcome, {
      errorCode: "CONFLICT",
      errorName: "GroupConflict",
      statusCode: 409,
    });
  });

  it("rejects a non-JSON 500 from dataset file content", async () => {
    const body = "<html>unavailable</html>";
    const contentType = "text/html";
    const env = await listen(textResponse(500, body, contentType));
    const message = await responseJsonMessage(body, contentType);
    const outcome = await asCaller(() =>
      readDatasetFile(env.context, "ri.dataset.1", "secret.txt")
    );

    expect(env.statuses).toEqual([false]);
    expect(env.requests[0]?.method).toBe("GET");
    expect(env.requests[0]?.url).toBe(
      "/api/v2/datasets/ri.dataset.1/files/secret.txt/content",
    );
    expectRejectedUnknownError(outcome, {
      message,
      errorName: "UNKNOWN",
    });
  });

  it("rejects a plain-text 502 from resource delete", async () => {
    const body = "bad gateway";
    const contentType = "text/plain";
    const env = await listen(textResponse(502, body, contentType));
    const message = await responseJsonMessage(body, contentType);
    const outcome = await asCaller(() =>
      deleteResource(env.client, "ri.resource.1")
    );

    expect(env.statuses).toEqual([false]);
    expect(env.requests[0]?.method).toBe("DELETE");
    expect(env.requests[0]?.url).toBe(
      "/api/v2/filesystem/resources/ri.resource.1",
    );
    expectRejectedUnknownError(outcome, {
      message,
      errorName: "UNKNOWN",
    });
  });

  it("rejects an event-stream call when the status is 401", async () => {
    const env = await listen(jsonResponse(401, {
      ...jsonError,
      errorCode: "UNAUTHENTICATED",
      errorName: "Unauthenticated",
    }));
    const body = { parameters: { name: "value" } };
    const outcome = await asCaller(() =>
      streamingExecuteEvents(
        env.context,
        "exampleQuery",
        body,
        { preview: true },
        { traceParent: "placeholder-trace" },
      )
    );

    expect(env.statuses).toEqual([false]);
    expect(env.requests[0]?.method).toBe("POST");
    expect(env.requests[0]?.url).toBe(
      "/api/v2/functions/queries/exampleQuery/streamingExecuteEvents?preview=true",
    );
    expect(env.requests[0]?.accept).toBe("text/event-stream");
    expect(env.requests[0]?.body).toBe(JSON.stringify(body));
    expectRejectedApiError(outcome, {
      errorCode: "UNAUTHENTICATED",
      errorName: "Unauthenticated",
      statusCode: 401,
    });
  });

  it("rejects when the error body cannot be parsed as an Error", async () => {
    const context: SharedClientContext = {
      baseUrl: "https://platform.example",
      fetch: async () => {
        return {
          ok: false,
          status: 500,
          json: async () => {
            throw "not-an-error";
          },
        } as unknown as Response;
      },
      tokenProvider: async () => "placeholder-token",
    };
    const outcome = await asCaller(() =>
      deleteFile(context, "ri.dataset.1", "secret.txt")
    );

    expectRejectedUnknownError(outcome, {
      message: "Unable to parse error response",
      errorName: "UNKNOWN",
    });
  });

  it("returns the JSON body when the status is OK", async () => {
    const body = { path: "keep.txt", transactionRid: "ri.tx.1" };
    const env = await listen(jsonResponse(200, body));
    const outcome = await asCaller(() =>
      getDatasetFile(env.context, "ri.dataset.1", "keep.txt")
    );

    expect(env.statuses).toEqual([true]);
    expect(outcome).toEqual({ ok: true, value: body });
  });
});
