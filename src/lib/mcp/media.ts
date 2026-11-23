import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { signingSecret } from "@/lib/crypto";
import { env } from "@/lib/env";
import { allowModel, applyGuardrails, modelChain } from "@/lib/gateway/access/gate";
import { usageFromUnknown } from "@/lib/gateway/billing/billing";
import { meter } from "@/lib/gateway/billing/meter";
import { asRecord, ownerId } from "@/lib/gateway/core";
import { forwardToModel } from "@/lib/gateway/dispatch/upstream";
import { GateError } from "@/lib/gateway/errors";
import { putObject } from "@/lib/gateway/storage/objects";
import { errorFields } from "@/lib/logging/format";
import { logger } from "@/lib/logging/logger";
import type { JsonMap, Principal } from "@/types/gateway";
import type { McpMediaSpec, McpToolOutcome, McpToolSpec } from "@/types/mcp";

export const MEDIA_SERVER_URL = "llmhub:media";
export const GENERATE_IMAGE_TOOL = "generate_image";
export const MEDIA_LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_IMAGES_PER_CALL = 4;
export const IMAGE_SIZES = ["auto", "1024x1024", "1536x1024", "1024x1536"] as const;

const MEDIA_PURPOSE = "media";
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", webp: "image/webp" };
const MAX_PROMPT_CHARS = 8000;

export function mediaSpec(raw: unknown): McpMediaSpec {
  const image = asRecord(asRecord(raw)?.image);
  return { image: { model: typeof image?.model === "string" ? image.model.trim() : "" } };
}

export function mediaToolSpecs(spec: McpMediaSpec): McpToolSpec[] {
  if (!spec.image.model) return [];
  return [
    {
      name: GENERATE_IMAGE_TOOL,
      title: "Generate image",
      description:
        "Creates images from a text description and returns download links. Write a detailed prompt in English. Show the returned links to the user as Markdown images.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Detailed description of the image to create." },
          size: { type: "string", enum: [...IMAGE_SIZES], description: "Image size. Defaults to auto." },
          count: { type: "integer", minimum: 1, maximum: MAX_IMAGES_PER_CALL, description: "Number of images. Defaults to 1." },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      action: "write",
    },
  ];
}

function linkSignature(id: string, expires: number): string {
  return createHmac("sha256", signingSecret()).update(`media-link:${id}:${expires}`).digest("base64url");
}

export function mediaLink(id: string, now = Date.now()): string {
  const expires = now + MEDIA_LINK_TTL_MS;
  const url = new URL(`/api/media/${encodeURIComponent(id)}`, env.NEXT_PUBLIC_APP_URL);
  url.searchParams.set("expires", String(expires));
  url.searchParams.set("signature", linkSignature(id, expires));
  return url.toString();
}

export function mediaLinkValid(id: string, expires: string | null, signature: string | null, now = Date.now()): boolean {
  const at = Number(expires);
  if (!expires || !signature || !Number.isSafeInteger(at) || at < now) return false;
  const expected = Buffer.from(linkSignature(id, at));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function isMediaObject(meta: unknown, purpose: string): boolean {
  return purpose === MEDIA_PURPOSE && asRecord(meta)?.media === true;
}

function imageRequest(model: string, args: JsonMap): JsonMap | string {
  const prompt = typeof args.prompt === "string" ? args.prompt.trim() : "";
  if (!prompt) return "prompt is required.";
  if (prompt.length > MAX_PROMPT_CHARS) return `prompt must be at most ${MAX_PROMPT_CHARS} characters.`;
  const body: JsonMap = { model, prompt };
  const count = typeof args.count === "number" ? Math.trunc(args.count) : 1;
  body.n = Math.min(MAX_IMAGES_PER_CALL, Math.max(1, count || 1));
  if (typeof args.size === "string" && args.size !== "auto" && (IMAGE_SIZES as readonly string[]).includes(args.size)) {
    body.size = args.size;
  }
  return body;
}

function imageType(response: JsonMap): { contentType: string; extension: string } {
  const format = typeof response.output_format === "string" ? response.output_format.toLowerCase() : "png";
  const contentType = IMAGE_TYPES[format] ?? "image/png";
  return { contentType, extension: contentType === "image/jpeg" ? "jpg" : contentType.slice("image/".length) };
}

async function storedImages(principal: Principal, response: JsonMap, model: string): Promise<JsonMap[]> {
  const items = Array.isArray(response.data) ? response.data : [];
  const { contentType, extension } = imageType(response);
  const images: JsonMap[] = [];
  for (const [index, raw] of items.entries()) {
    const item = asRecord(raw);
    if (!item) continue;
    const revised = typeof item.revised_prompt === "string" ? { revised_prompt: item.revised_prompt } : {};
    if (typeof item.b64_json === "string" && item.b64_json) {
      const stored = await putObject({
        kind: "file",
        owner: ownerId(principal),
        filename: `image-${index + 1}.${extension}`,
        purpose: MEDIA_PURPOSE,
        contentType,
        payload: Buffer.from(item.b64_json, "base64"),
        meta: { media: true, model },
      });
      images.push({ url: mediaLink(stored.id), file_id: stored.id, content_type: contentType, ...revised });
    } else if (typeof item.url === "string" && item.url) {
      images.push({ url: item.url, ...revised });
    }
  }
  return images;
}

function failure(text: string): McpToolOutcome {
  return { text, isError: true };
}

async function generateImage(spec: McpMediaSpec, args: JsonMap, principal: Principal): Promise<McpToolOutcome> {
  const model = spec.image.model;
  if (!model) return failure("No image model is configured for this server.");
  const request = imageRequest(model, args);
  if (typeof request === "string") return failure(request);
  allowModel(principal, model);
  const clean = (await applyGuardrails(request, principal)).body;
  const aliases = modelChain(principal, model, clean);
  const usage = meter(principal, model, request);
  let response: JsonMap;
  try {
    const hit = await forwardToModel(aliases, principal, "/images/generations", clean);
    await usage.ok(hit, usageFromUnknown(asRecord(hit.json)?.usage, hit.json));
    response = asRecord(hit.json) ?? {};
  } catch (err) {
    await usage.fail(err);
    throw err;
  }
  const images = await storedImages(principal, response, model);
  if (!images.length) return failure("The image model returned no images.");
  return {
    text: JSON.stringify({
      images,
      note: "Show each url to the user as a Markdown image. Links expire after 7 days.",
    }),
    isError: false,
  };
}

export async function callMedia(
  spec: McpMediaSpec,
  tool: string,
  args: JsonMap,
  principal: Principal | null,
): Promise<McpToolOutcome> {
  if (!principal) return failure("This tool needs a signed-in caller.");
  try {
    if (tool === GENERATE_IMAGE_TOOL) return await generateImage(spec, args, principal);
    return failure(`Unknown tool ${tool}.`);
  } catch (err) {
    if (err instanceof GateError) return failure(`Image generation failed: ${err.message}`);
    logger.warn("mcp.media_failed", { tool, ...errorFields(err) });
    return failure("Image generation failed.");
  }
}
