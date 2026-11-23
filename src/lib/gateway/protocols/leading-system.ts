import { asRecord, stringifyContent } from "@/lib/gateway/core";
import type { JsonMap } from "@/types/gateway";

function isSystemMessage(message: unknown): boolean {
  return asRecord(message)?.role === "system";
}

export function withSingleLeadingSystem(body: JsonMap): JsonMap {
  if (!Array.isArray(body.messages)) return body;
  const messages: unknown[] = body.messages;
  const systemCount = messages.filter(isSystemMessage).length;
  if (systemCount === 0 || (systemCount === 1 && isSystemMessage(messages[0]))) return body;
  const system = messages
    .filter(isSystemMessage)
    .map((message) => stringifyContent(asRecord(message)?.content))
    .filter(Boolean)
    .join("\n\n");
  const rest = messages.filter((message) => !isSystemMessage(message));
  return { ...body, messages: system ? [{ role: "system", content: system }, ...rest] : rest };
}
