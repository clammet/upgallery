import { describe, expect, test } from "vitest";
import { filterFolderTree } from "../src/lib/folderSearch";

const folders = [
  { _id: "root", name: "Gallery", ancestorIds: [] },
  { _id: "events", name: "Events", ancestorIds: ["root"] },
  { _id: "summer", name: "Summer trip", ancestorIds: ["root", "events"] },
  { _id: "photos", name: "Photos", ancestorIds: ["root", "events", "summer"] },
  { _id: "winter", name: "Winter trip", ancestorIds: ["root", "events"] },
  { _id: "family", name: "Family", ancestorIds: ["root"] },
  { _id: "family-trip", name: "Summer trip", ancestorIds: ["root", "family"] },
];

describe("folder tree search", () => {
  test("keeps matches and their complete parent chains in tree order", () => {
    expect(filterFolderTree(folders, "  SUMMER  ").map((folder) => folder._id))
      .toEqual(["root", "events", "summer", "family", "family-trip"]);
  });

  test("keeps shared ancestors once and excludes unrelated descendants", () => {
    expect(filterFolderTree(folders, "trip").map((folder) => folder._id))
      .toEqual(["root", "events", "summer", "winter", "family", "family-trip"]);
    expect(filterFolderTree(folders, "Gallery")).toEqual([folders[0]]);
  });

  test("restores the full tree for an empty search", () => {
    expect(filterFolderTree(folders, "")).toEqual(folders);
    expect(filterFolderTree(folders, "   ")).toEqual(folders);
  });

  test("returns no folders when nothing matches or the tree is empty", () => {
    expect(filterFolderTree(folders, "missing")).toEqual([]);
    expect(filterFolderTree([], "summer")).toEqual([]);
  });
});
