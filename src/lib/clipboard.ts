// Keep pasted image names identical in galleries and the uploader.
export function clipboardImageFile(file: File, now = new Date()): File {
  const pad = (value: number) => String(value).padStart(2, "0");
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const extension =
    /\.([a-z0-9]+)$/i.exec(file.name)?.[1] ??
    file.type.slice("image/".length).split("+")[0];
  return new File([file], `Clipboard-${timestamp}.${extension}`, {
    type: file.type,
    lastModified: file.lastModified,
  });
}

export async function copyTextToClipboard(value: string) {
  if (navigator.clipboard !== undefined) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Fall through for browsers that expose the API but deny it here.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) throw new Error("Clipboard access is not available");
}
