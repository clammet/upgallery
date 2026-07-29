export function friendlyError(reason: unknown, fallback = "Request failed"): string {
  if (!(reason instanceof Error)) {
    return fallback;
  }
  const serverMessage = /Uncaught Error:\s*([^\n]+)/.exec(reason.message)?.[1];
  if (serverMessage) {
    return serverMessage.replace(/\s+at\s+handler.*$/, "").trim();
  }
  const firstLine = reason.message.split("\n")[0]?.trim();
  return firstLine || fallback;
}
