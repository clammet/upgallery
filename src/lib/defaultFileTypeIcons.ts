import archiveThumbnailUrl from "../assets/file-type-icons/archive.png";
import audioThumbnailUrl from "../assets/file-type-icons/audio.png";
import codeThumbnailUrl from "../assets/file-type-icons/code.png";
import documentThumbnailUrl from "../assets/file-type-icons/document.png";
import flashThumbnailUrl from "../assets/file-type-icons/flash.png";
import plaintextThumbnailUrl from "../assets/file-type-icons/plaintext.png";
import playlistThumbnailUrl from "../assets/file-type-icons/playlist.png";
import unknownThumbnailUrl from "../assets/file-type-icons/unknown.png";
import videoThumbnailUrl from "../assets/file-type-icons/video.png";
import { codeFileExtensions } from "./codeLanguages";

export type FileTypeIconDefinition = {
  icon: string;
  label: string;
  thumbnailUrl: string;
};

const defaultFileTypeIconGroups: Array<
  FileTypeIconDefinition & { extensions: string[] }
> = [
  {
    extensions: ["7z", "bz", "bz2", "gz", "rar", "tar", "tgz", "xz", "zip"],
    icon: "ARC",
    label: "Archive",
    thumbnailUrl: archiveThumbnailUrl,
  },
  {
    extensions: [
      "aac",
      "aiff",
      "flac",
      "m4a",
      "mid",
      "midi",
      "mp3",
      "oga",
      "ogg",
      "opus",
      "wav",
      "wma",
    ],
    icon: "AUD",
    label: "Audio file",
    thumbnailUrl: audioThumbnailUrl,
  },
  {
    extensions: codeFileExtensions,
    icon: "CODE",
    label: "Source code",
    thumbnailUrl: codeThumbnailUrl,
  },
  {
    extensions: [
      "csv",
      "doc",
      "docx",
      "epub",
      "key",
      "numbers",
      "odf",
      "odg",
      "odp",
      "ods",
      "odt",
      "pages",
      "pdf",
      "ppt",
      "pptx",
      "rtf",
      "xls",
      "xlsx",
    ],
    icon: "DOC",
    label: "Document",
    thumbnailUrl: documentThumbnailUrl,
  },
  {
    extensions: ["fla", "flv", "swf"],
    icon: "FLASH",
    label: "Flash file",
    thumbnailUrl: flashThumbnailUrl,
  },
  {
    extensions: ["cfg", "conf", "ini", "log", "md", "nfo", "text", "txt"],
    icon: "TXT",
    label: "Plain text file",
    thumbnailUrl: plaintextThumbnailUrl,
  },
  {
    extensions: ["asx", "cue", "m3u", "m3u8", "pls", "xspf"],
    icon: "LIST",
    label: "Playlist",
    thumbnailUrl: playlistThumbnailUrl,
  },
  {
    extensions: [
      "3gp",
      "avi",
      "m4v",
      "mkv",
      "mov",
      "mp4",
      "mpeg",
      "mpg",
      "ogv",
      "webm",
      "wmv",
    ],
    icon: "VID",
    label: "Video file",
    thumbnailUrl: videoThumbnailUrl,
  },
];

export const defaultFileTypeIcons: Record<string, FileTypeIconDefinition> =
  Object.fromEntries(
    defaultFileTypeIconGroups.flatMap(
      ({ extensions, ...definition }) =>
        extensions.map((extension) => [extension, definition]),
    ),
  );

export const unknownFileTypeIcon: FileTypeIconDefinition = {
  icon: "FILE",
  label: "File",
  thumbnailUrl: unknownThumbnailUrl,
};

export function resolveDefaultFileTypeIcon(
  extension: string,
): FileTypeIconDefinition {
  const normalized = extension.trim().toLocaleLowerCase().replace(/^\./, "");
  return defaultFileTypeIcons[normalized] ?? unknownFileTypeIcon;
}
