import { API_KEY, gateway, gatewayRequest, groupRow, resetGateway, type UpstreamCall } from "./support/gateway-harness";
import { recordedPrisma } from "./support/recorded-prisma";
import assert from "node:assert/strict";
import test from "node:test";
import { MCP_PROTOCOL_VERSION } from "@/lib/mcp/client";
import {
  GENERATE_IMAGE_TOOL,
  MEDIA_LINK_TTL_MS,
  MEDIA_SERVER_URL,
  mediaLink,
  mediaLinkValid,
  mediaSpec,
  mediaToolSpecs,
} from "@/lib/mcp/media";
import type { JsonMap } from "@/types/gateway";

const IMAGE_MODEL = "image-test";
const PIXEL = Buffer.from("fake-png-bytes");

type StoredRow = JsonMap & { id: string; payload: Uint8Array | null };

function mediaServerRow(model = IMAGE_MODEL) {
  const spec = { image: { model } };
  return {
    id: "media1",
    name: "media",
    url: MEDIA_SERVER_URL,
    authType: "none",
    authHeader: "",
    authSecret: "",
    oauthGrant: "authorization_code",
    oauthClientId: "",
    oauthScopes: "",
    transport: "streamable_http",
    protocolVersion: MCP_PROTOCOL_VERSION,
    kind: "media",
    spec,
    internal: false,
    enabled: true,
    global: true,
    template: false,
    toolsRestricted: false,
    allowedTools: [],
    tools: mediaToolSpecs(mediaSpec(spec)),
    toolActions: {},
    oauthLogin: null,
    installations: [],
    assignments: [],
  };
}

function setup(reply: (call: UpstreamCall) => Response) {
  resetGateway();
  gateway.groups.set(IMAGE_MODEL, groupRow(IMAGE_MODEL));
  gateway.reply = reply;
  const stored: StoredRow[] = [];
  recordedPrisma.handlers = {
    mcpServer: { findMany: () => [mediaServerRow()] },
    storedObject: {
      create: ({ data }: { data: JsonMap }) => {
        const row = { id: `obj${stored.length + 1}`, createdAt: new Date(0), payload: null, ...data } as StoredRow;
        stored.push(row);
        return row;
      },
      findUnique: ({ where }: { where: { id: string } }) => stored.find((row) => row.id === where.id) ?? null,
    },
  };
  return stored;
}

async function hub(body: JsonMap): Promise<JsonMap> {
  const { POST } = await import("@/app/api/v1/mcp/route");
  const res = await POST(gatewayRequest("/api/v1/mcp", { jsonrpc: "2.0", id: 1, ...body }));
  assert.equal(res.status, 200);
  return (await res.json()) as JsonMap;
}

function imageReply(call: UpstreamCall): Response {
  if (!call.url.endsWith("/images/generations")) return Response.json({});
  return Response.json({ created: 1, data: [{ b64_json: PIXEL.toString("base64"), revised_prompt: "a red fox" }] });
}

test("media servers list generate_image only when an image model is set", () => {
  assert.deepEqual(mediaToolSpecs(mediaSpec({})), []);
  assert.deepEqual(mediaSpec({ image: { model: " img " } }), { image: { model: "img" } });
  const [tool] = mediaToolSpecs(mediaSpec({ image: { model: "img" } }));
  assert.equal(tool?.name, GENERATE_IMAGE_TOOL);
  assert.deepEqual((tool?.inputSchema as JsonMap).required, ["prompt"]);
});

test("media links verify their signature and expire", () => {
  const now = 1_800_000_000_000;
  const url = new URL(mediaLink("obj1", now));
  const expires = url.searchParams.get("expires");
  const signature = url.searchParams.get("signature");
  assert.equal(url.pathname, "/api/media/obj1");
  assert.equal(Number(expires), now + MEDIA_LINK_TTL_MS);
  assert.equal(mediaLinkValid("obj1", expires, signature, now), true);
  assert.equal(mediaLinkValid("obj2", expires, signature, now), false);
  assert.equal(mediaLinkValid("obj1", String(Number(expires) + 1), signature, now), false);
  assert.equal(mediaLinkValid("obj1", expires, `${signature}x`, now), false);
  assert.equal(mediaLinkValid("obj1", expires, signature, now + MEDIA_LINK_TTL_MS + 1), false);
  assert.equal(mediaLinkValid("obj1", null, signature, now), false);
});

test("generate_image runs the image model as the caller and returns a working link", async () => {
  const stored = setup(imageReply);
  const listed = await hub({ method: "tools/list" });
  const names = ((listed.result as JsonMap).tools as JsonMap[]).map((tool) => tool.name);
  assert.equal(names.length, 1);
  assert.match(String(names[0]), /generate_image/);

  const called = await hub({ method: "tools/call", params: { name: names[0], arguments: { prompt: "a fox", size: "1024x1024", count: 9 } } });
  const result = called.result as JsonMap;
  assert.equal(result.isError, false);
  const upstream = gateway.upstream.find((call) => call.url.endsWith("/images/generations"));
  const { model, prompt, n, size } = upstream?.body ?? {};
  assert.deepEqual({ model, prompt, n, size }, { model: IMAGE_MODEL, prompt: "a fox", n: 4, size: "1024x1024" });
  assert.notEqual(upstream?.headers.authorization, `Bearer ${API_KEY}`);

  const payload = JSON.parse(String(((result.content as JsonMap[])[0] as JsonMap).text)) as { images: JsonMap[] };
  assert.equal(payload.images.length, 1);
  assert.equal(payload.images[0]?.revised_prompt, "a red fox");
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.purpose, "media");
  assert.equal(stored[0]?.owner, gateway.key.id);

  const { GET } = await import("@/app/api/media/[id]/route");
  const link = new URL(String(payload.images[0]?.url));
  const params = { params: Promise.resolve({ id: "obj1" }) };
  const res = await GET(new Request(link), params);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await res.arrayBuffer()), PIXEL);

  link.searchParams.set("signature", "forged");
  assert.equal((await GET(new Request(link), params)).status, 403);
});

test("generate_image reports missing prompts and upstream failures as tool errors", async () => {
  setup(() => Response.json({ error: { message: "content policy" } }, { status: 400 }));
  const name = String((((await hub({ method: "tools/list" })).result as JsonMap).tools as JsonMap[])[0]?.name);
  const empty = (await hub({ method: "tools/call", params: { name, arguments: { prompt: " " } } })).result as JsonMap;
  assert.equal(empty.isError, true);
  assert.equal(gateway.upstream.length, 0);
  const failed = (await hub({ method: "tools/call", params: { name, arguments: { prompt: "a fox" } } })).result as JsonMap;
  assert.equal(failed.isError, true);
  assert.match(String(((failed.content as JsonMap[])[0] as JsonMap).text), /Image generation failed/);
});

test("the media download route refuses unsigned requests before reading data", async () => {
  setup(imageReply);
  const { GET } = await import("@/app/api/media/[id]/route");
  const res = await GET(new Request("https://hub.test/api/media/obj1"), { params: Promise.resolve({ id: "obj1" }) });
  assert.equal(res.status, 403);
  assert.equal(recordedPrisma.called("storedObject").length, 0);
});
