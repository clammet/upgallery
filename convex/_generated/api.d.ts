/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as authMaintenance from "../authMaintenance.js";
import type * as authOrigins from "../authOrigins.js";
import type * as bulkOperations from "../bulkOperations.js";
import type * as crons from "../crons.js";
import type * as entries from "../entries.js";
import type * as fileTypeIcons from "../fileTypeIcons.js";
import type * as filesystemSync from "../filesystemSync.js";
import type * as folderStats from "../folderStats.js";
import type * as folders from "../folders.js";
import type * as galleries from "../galleries.js";
import type * as galleryCleanup from "../galleryCleanup.js";
import type * as http from "../http.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_bulkOperations from "../lib/bulkOperations.js";
import type * as lib_crypto from "../lib/crypto.js";
import type * as lib_ensureProfile from "../lib/ensureProfile.js";
import type * as lib_entryNames from "../lib/entryNames.js";
import type * as lib_filesystem from "../lib/filesystem.js";
import type * as lib_filesystemSyncStatus from "../lib/filesystemSyncStatus.js";
import type * as lib_folderAccess from "../lib/folderAccess.js";
import type * as lib_folderStats from "../lib/folderStats.js";
import type * as lib_format from "../lib/format.js";
import type * as lib_galleryStats from "../lib/galleryStats.js";
import type * as lib_normalize from "../lib/normalize.js";
import type * as lib_permissions from "../lib/permissions.js";
import type * as lib_profiles from "../lib/profiles.js";
import type * as lib_storageJobs from "../lib/storageJobs.js";
import type * as lib_validators from "../lib/validators.js";
import type * as migrations from "../migrations.js";
import type * as profiles from "../profiles.js";
import type * as roles from "../roles.js";
import type * as storageGateway from "../storageGateway.js";
import type * as storageJobs from "../storageJobs.js";
import type * as ticketMaintenance from "../ticketMaintenance.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  authMaintenance: typeof authMaintenance;
  authOrigins: typeof authOrigins;
  bulkOperations: typeof bulkOperations;
  crons: typeof crons;
  entries: typeof entries;
  fileTypeIcons: typeof fileTypeIcons;
  filesystemSync: typeof filesystemSync;
  folderStats: typeof folderStats;
  folders: typeof folders;
  galleries: typeof galleries;
  galleryCleanup: typeof galleryCleanup;
  http: typeof http;
  "lib/auth": typeof lib_auth;
  "lib/bulkOperations": typeof lib_bulkOperations;
  "lib/crypto": typeof lib_crypto;
  "lib/ensureProfile": typeof lib_ensureProfile;
  "lib/entryNames": typeof lib_entryNames;
  "lib/filesystem": typeof lib_filesystem;
  "lib/filesystemSyncStatus": typeof lib_filesystemSyncStatus;
  "lib/folderAccess": typeof lib_folderAccess;
  "lib/folderStats": typeof lib_folderStats;
  "lib/format": typeof lib_format;
  "lib/galleryStats": typeof lib_galleryStats;
  "lib/normalize": typeof lib_normalize;
  "lib/permissions": typeof lib_permissions;
  "lib/profiles": typeof lib_profiles;
  "lib/storageJobs": typeof lib_storageJobs;
  "lib/validators": typeof lib_validators;
  migrations: typeof migrations;
  profiles: typeof profiles;
  roles: typeof roles;
  storageGateway: typeof storageGateway;
  storageJobs: typeof storageJobs;
  ticketMaintenance: typeof ticketMaintenance;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  googlyAuth: import("@clammet/convex-googly-auth/_generated/component.js").ComponentApi<"googlyAuth">;
  migrations: import("@convex-dev/migrations/_generated/component.js").ComponentApi<"migrations">;
};
