const textEncoder = new TextEncoder();
const PASSWORD_ITERATIONS = 210_000;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function createToken(byteLength = 32): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function createPasswordHash(password: string): Promise<{
  salt: string;
  hash: string;
  iterations: number;
}> {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const hash = await derivePasswordHash(
    password,
    saltBytes,
    PASSWORD_ITERATIONS,
  );
  return {
    salt: bytesToBase64Url(saltBytes),
    hash,
    iterations: PASSWORD_ITERATIONS,
  };
}

export async function verifyPassword(
  password: string,
  salt: string,
  expectedHash: string,
  iterations: number,
): Promise<boolean> {
  const actualHash = await derivePasswordHash(
    password,
    base64UrlToBytes(salt),
    iterations,
  );
  if (actualHash.length !== expectedHash.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < actualHash.length; index += 1) {
    difference |= actualHash.charCodeAt(index) ^ expectedHash.charCodeAt(index);
  }
  return difference === 0;
}

async function derivePasswordHash(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    textEncoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as Uint8Array<ArrayBuffer>,
      iterations,
    },
    key,
    256,
  );
  return bytesToBase64Url(new Uint8Array(bits));
}
