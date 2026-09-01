export type GallerySortOrder =
  | "nameAsc"
  | "nameDesc"
  | "sizeAsc"
  | "sizeDesc"
  | "dateAsc"
  | "dateDesc";

export const GALLERY_SORT_OPTIONS: ReadonlyArray<{
  value: GallerySortOrder;
  label: string;
}> = [
  { value: "nameAsc", label: "Filename/title — A to Z" },
  { value: "nameDesc", label: "Filename/title — Z to A" },
  { value: "sizeAsc", label: "Size — smallest to largest" },
  { value: "sizeDesc", label: "Size — largest to smallest" },
  { value: "dateAsc", label: "Date taken — earlier to later" },
  { value: "dateDesc", label: "Date taken — later to earlier" },
];
