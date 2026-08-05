const MAX_TEXT_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_CACHED_PREVIEWS = 20;
const textRequests = new Map<string, Promise<string>>();

class PreviewTooLargeError extends Error {
  constructor() {
    super("This text file is too large to preview safely.");
  }
}

export async function readTextPreviewResponse(
  response: Response,
  maxBytes = MAX_TEXT_PREVIEW_BYTES,
): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new PreviewTooLargeError();
  }

  if (response.body === null) {
    const body = await response.arrayBuffer();
    if (body.byteLength > maxBytes) throw new PreviewTooLargeError();
    return new TextDecoder().decode(body);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let receivedBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    receivedBytes += value.byteLength;
    if (receivedBytes > maxBytes) {
      await reader.cancel();
      throw new PreviewTooLargeError();
    }
    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

export function loadTextPreview(
  sourceUrl: string,
  accept = "text/plain",
): Promise<string> {
  const cached = textRequests.get(sourceUrl);
  if (cached !== undefined) return cached;

  const request = fetch(sourceUrl, { headers: { accept } })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Could not load this text file (${response.status}).`);
      }
      return await readTextPreviewResponse(response);
    })
    .catch((error: unknown) => {
      textRequests.delete(sourceUrl);
      throw error;
    });
  textRequests.set(sourceUrl, request);

  if (textRequests.size > MAX_CACHED_PREVIEWS) {
    const oldestUrl = textRequests.keys().next().value;
    if (oldestUrl !== undefined) textRequests.delete(oldestUrl);
  }
  return request;
}
