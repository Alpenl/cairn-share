// Bound bytes while reading, including chunked requests and dishonest/missing
// Content-Length. Never buffer an entire invalid request before applying limits.
export class JSONBodyError extends Error {
  constructor(readonly code: "invalid_json" | "invalid_content_type" | "request_too_large") {
    super(code);
  }
}

export async function readBoundedJSON(request: Request, maxBytes = 1 << 20, requireContentType = true): Promise<unknown> {
  if (requireContentType && request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new JSONBodyError("invalid_content_type");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new JSONBodyError("invalid_json");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new JSONBodyError("request_too_large");
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch (cause) {
    if (cause instanceof JSONBodyError) throw cause;
    throw new JSONBodyError("invalid_json");
  } finally {
    reader.releaseLock();
  }
}

export async function readJSONObject(request: Request, maxBytes = 1 << 20): Promise<Record<string, unknown> | null> {
  try {
    const body = await readBoundedJSON(request, maxBytes);
    return body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
  } catch { return null; }
}
