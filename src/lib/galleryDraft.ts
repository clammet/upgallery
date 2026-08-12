export const AUTO_PREFIX_ATTEMPTS_PER_LENGTH = 3;
export const INITIAL_AUTO_PREFIX_LENGTH = 2;

export type PrefixAttempt = {
  prefix: string;
  prefixLength: number;
  attempt: number;
};

type RandomHex = (length: number, previous?: string) => string;

export function galleryNamePathSegment(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function randomHex(length: number, previous?: string): string {
  let result = "";
  do {
    const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)));
    result = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
      .join("")
      .slice(0, length);
  } while (result === previous);
  return result;
}

export function firstPrefixAttempt(
  makeRandomHex: RandomHex = randomHex,
): PrefixAttempt {
  return {
    prefix: makeRandomHex(INITIAL_AUTO_PREFIX_LENGTH),
    prefixLength: INITIAL_AUTO_PREFIX_LENGTH,
    attempt: 1,
  };
}

export function nextPrefixAttempt(
  current: PrefixAttempt,
  makeRandomHex: RandomHex = randomHex,
): PrefixAttempt {
  const exhaustedLength = current.attempt >= AUTO_PREFIX_ATTEMPTS_PER_LENGTH;
  const prefixLength = exhaustedLength
    ? current.prefixLength + 1
    : current.prefixLength;
  return {
    prefix: makeRandomHex(prefixLength, current.prefix),
    prefixLength,
    attempt: exhaustedLength ? 1 : current.attempt + 1,
  };
}

export function generatedGalleryFields(
  pathSegment: string,
  prefix: string,
): { slug: string; storageRoot: string; rootPath: string } {
  if (pathSegment.length < 2) {
    return { slug: "", storageRoot: "", rootPath: "/" };
  }
  const slugSegment = pathSegment.slice(0, 80 - prefix.length - 1);
  const slug = `${prefix}-${slugSegment}`;
  return {
    slug,
    storageRoot: slug,
    rootPath: `/${prefix}/${pathSegment}`,
  };
}
