import type { ModelDescriptor } from "@harness/protocol"
import type { Model } from "./generated/0.153.4/v2/Model"
import type { ModelListParams } from "./generated/0.153.4/v2/ModelListParams"
import type { ModelListResponse } from "./generated/0.153.4/v2/ModelListResponse"
import { isRecord } from "./stdio"

/** Bounded native picker projection. Catalog entries do not attest model capabilities or admission. */
export async function readCodexModels(
  request: (params: ModelListParams) => Promise<unknown>,
): Promise<readonly ModelDescriptor[]> {
  const models: ModelDescriptor[] = []
  const ids = new Set<string>()
  const cursors = new Set<string>()
  let cursor: string | null = null
  let received = 0
  let bytes = 2
  for (let index = 0; index < 8; index++) {
    const limit = Math.min(100, 256 - received)
    if (limit === 0) throw new Error("Native model count exceeded")
    const response = modelPage(await request({ cursor, limit, includeHidden: false }), limit)
    received += response.data.length
    for (const entry of response.data) {
      // The native `model` is the dispatch string; `id` is catalog metadata.
      if (ids.has(entry.model)) throw new Error("Duplicate native model")
      ids.add(entry.model)
      if (entry.hidden) continue
      const model = { id: entry.model, name: entry.displayName, providerId: "openai", capabilities: {} }
      bytes += Buffer.byteLength(JSON.stringify(model)) + (models.length ? 1 : 0)
      if (bytes > 128 * 1024) throw new Error("Native model projection exceeds its byte limit")
      models.push(model)
    }
    cursor = response.nextCursor
    if (cursor === null) return models
    if (cursors.has(cursor)) throw new Error("Native model cursor loop")
    cursors.add(cursor)
  }
  throw new Error("Native model page count exceeded")
}

function modelPage(
  value: unknown,
  limit: number,
): { data: Pick<Model, "model" | "displayName" | "hidden">[]; nextCursor: ModelListResponse["nextCursor"] } {
  if (
    !isRecord(value) ||
    !Array.isArray(value.data) ||
    value.data.length > limit ||
    !(value.nextCursor === null || validCursor(value.nextCursor))
  )
    throw new Error("Invalid native model page")
  return {
    data: value.data.map((entry: unknown) => {
      if (
        !isRecord(entry) ||
        typeof entry.model !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.model) ||
        typeof entry.displayName !== "string" ||
        !entry.displayName.length ||
        entry.displayName.length > 256 ||
        entry.displayName.trim() !== entry.displayName ||
        /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(entry.displayName) ||
        typeof entry.hidden !== "boolean"
      )
        throw new Error("Invalid native model picker fields")
      return { model: entry.model, displayName: entry.displayName, hidden: entry.hidden }
    }),
    nextCursor: value.nextCursor,
  }
}

function validCursor(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= 4096 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  )
}
