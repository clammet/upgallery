const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cts: "typescript",
  cxx: "cpp",
  diff: "diff",
  go: "go",
  gql: "graphql",
  graphql: "graphql",
  h: "cpp",
  hh: "cpp",
  hpp: "cpp",
  htm: "xml",
  html: "xml",
  hxx: "cpp",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  less: "less",
  lua: "lua",
  m: "objectivec",
  mjs: "javascript",
  mm: "objectivec",
  mts: "typescript",
  patch: "diff",
  php: "php",
  phtml: "php",
  pl: "perl",
  pm: "perl",
  py: "python",
  pyw: "python",
  r: "r",
  rb: "ruby",
  rs: "rust",
  scss: "scss",
  sh: "bash",
  sql: "sql",
  swift: "swift",
  toml: "ini",
  ts: "typescript",
  tsx: "typescript",
  vb: "vbnet",
  wasm: "wasm",
  wat: "wasm",
  xhtml: "xml",
  xml: "xml",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

const LANGUAGE_BY_FILE_NAME: Record<string, string> = {
  gemfile: "ruby",
  makefile: "makefile",
  podfile: "ruby",
  rakefile: "ruby",
};

const LANGUAGE_BY_MIME_TYPE: Record<string, string> = {
  "application/graphql": "graphql",
  "application/javascript": "javascript",
  "application/json": "json",
  "application/sql": "sql",
  "application/typescript": "typescript",
  "application/x-httpd-php": "php",
  "application/x-javascript": "javascript",
  "application/xml": "xml",
  "text/css": "css",
  "text/javascript": "javascript",
  "text/jsx": "javascript",
  "text/typescript": "typescript",
  "text/tsx": "typescript",
  "text/x-c": "c",
  "text/x-c++": "cpp",
  "text/x-csharp": "csharp",
  "text/x-go": "go",
  "text/x-java-source": "java",
  "text/x-python": "python",
  "text/x-ruby": "ruby",
  "text/x-rust": "rust",
  "text/x-shellscript": "bash",
  "text/x-sql": "sql",
  "text/xml": "xml",
  "text/yaml": "yaml",
};

export const codeFileExtensions = Object.keys(LANGUAGE_BY_EXTENSION);

function normalizedMimeType(mimeType: string): string {
  return mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
}

export function codeLanguageForFile(
  fileName: string,
  mimeType: string,
): string | null {
  const normalizedName = fileName.trim().toLowerCase();
  if (/\.(?:md|markdown|txt)$/.test(normalizedName)) return null;
  const exactNameLanguage = LANGUAGE_BY_FILE_NAME[normalizedName];
  if (exactNameLanguage !== undefined) return exactNameLanguage;

  const finalDot = normalizedName.lastIndexOf(".");
  if (finalDot >= 0 && finalDot < normalizedName.length - 1) {
    const extensionLanguage =
      LANGUAGE_BY_EXTENSION[normalizedName.slice(finalDot + 1)];
    if (extensionLanguage !== undefined) return extensionLanguage;
  }

  const mime = normalizedMimeType(mimeType);
  const exactMimeLanguage = LANGUAGE_BY_MIME_TYPE[mime];
  if (exactMimeLanguage !== undefined) return exactMimeLanguage;
  if (mime.endsWith("+json")) return "json";
  if (mime.endsWith("+xml")) return "xml";
  return null;
}

export function shouldRenderAsCode(
  fileName: string,
  mimeType: string,
): boolean {
  return codeLanguageForFile(fileName, mimeType) !== null;
}
