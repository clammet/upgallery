import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  bulkConflictPolicy,
  bulkOperationStatus,
  conflictPolicy,
  disposition,
  entryMoveJobState,
  entryState,
  folderAccessPolicy,
  folderDiscoverability,
  folderPreviewMode,
  gallerySortOrder,
  galleryKind,
  galleryRole,
  jobState,
  mediaKind,
  storageKind,
  systemGalleryRole,
  themeValidator,
  thumbnailState,
  uploadState,
} from "./lib/validators";

export default defineSchema({
  profiles: defineTable({
    identityId: v.string(),
    displayName: v.optional(v.string()),
    // Set once the user picks their own name; stops sign-in from replacing
    // it with the identity provider's name.
    displayNameCustom: v.optional(v.boolean()),
    email: v.optional(v.string()),
    image: v.optional(v.string()),
    isAnonymous: v.boolean(),
    // Per-user infinite scroll preference. Undefined means on; a gallery
    // that disables infinite scroll wins regardless.
    infiniteScroll: v.optional(v.boolean()),
    // Lets the lightbox zoom images past their natural size. Undefined
    // means off.
    overzoom: v.optional(v.boolean()),
    isSystemAdmin: v.boolean(),
    lastSeenAt: v.number(),
  })
    .index("by_identityId", ["identityId"])
    .index("by_email", ["email"]),

  galleries: defineTable({
    name: v.string(),
    slug: v.string(),
    kind: galleryKind,
    storageKind,
    storageRoot: v.string(),
    maxFileSize: v.number(),
    // Ceiling for maxFileSize set by system admins; gallery owners can only
    // lower maxFileSize below it. Absent on legacy galleries, where the
    // effective limit is the current maxFileSize.
    maxFileSizeLimit: v.optional(v.number()),
    // Special principals shown alongside ordinary gallery grants. Missing
    // values on pre-existing galleries use the default viewer role.
    anonymousRole: v.optional(systemGalleryRole),
    authenticatedRole: v.optional(systemGalleryRole),
    rootFolderId: v.optional(v.id("folders")),
    folderPreviewMode: v.optional(folderPreviewMode),
    folderPreviewSource: v.optional(v.string()),
    // Fill folder-tile previews from descendant subfolders when a folder's
    // own images run short. Owner-controlled; undefined means off.
    folderPreviewRecursive: v.optional(v.boolean()),
    // Allows owners to drag items into folders without entering select mode.
    quickMove: v.optional(v.boolean()),
    // Lets editors use the owner-only select, move, and delete tools.
    editorBulkActions: v.optional(v.boolean()),
    // Undefined preserves the default-on behavior for galleries created
    // before pagination settings were introduced.
    infiniteScroll: v.optional(v.boolean()),
    // Gallery entry page size. Undefined means the default of 100.
    paginationPageSize: v.optional(v.number()),
    // Prefer human-readable folder-name paths over ?folder=<id> URLs.
    friendlyFolderUrls: v.optional(v.boolean()),
    // Thumbnail ordering for image galleries. Legacy galleries default to
    // case-insensitive filename order (A-Z).
    sortOrder: v.optional(gallerySortOrder),
    theme: themeValidator,
    // Legacy counters. Live counts are in galleryStats (see
    // lib/galleryStats.ts); these only seed that row for galleries created
    // before it existed and are never updated.
    itemCount: v.optional(v.number()),
    totalBytes: v.optional(v.number()),
    pendingMigrationId: v.optional(v.id("storageMigrations")),
    deletedAt: v.optional(v.number()),
  })
    .index("by_slug", ["slug"])
    .index("by_storageRoot", ["storageRoot"]),

  // Item and byte totals per gallery, kept apart from the gallery document so
  // uploads and deletes do not invalidate every query that reads the gallery.
  galleryStats: defineTable({
    galleryId: v.id("galleries"),
    itemCount: v.number(),
    totalBytes: v.number(),
  }).index("by_galleryId", ["galleryId"]),

  // Ready-file count and bytes per folder (see lib/folderStats.ts). Kept
  // apart from the folder document for the same reason as galleryStats.
  folderStats: defineTable({
    folderId: v.id("folders"),
    galleryId: v.id("galleries"),
    itemCount: v.number(),
    totalBytes: v.number(),
  })
    .index("by_folderId", ["folderId"])
    .index("by_galleryId", ["galleryId"]),

  galleryHosts: defineTable({
    galleryId: v.id("galleries"),
    host: v.string(),
    rootPath: v.string(),
  })
    .index("by_host", ["host"])
    .index("by_galleryId", ["galleryId"]),

  folders: defineTable({
    galleryId: v.id("galleries"),
    parentId: v.optional(v.id("folders")),
    ancestorIds: v.array(v.id("folders")),
    name: v.string(),
    slug: v.string(),
    accessPolicy: folderAccessPolicy,
    discoverability: folderDiscoverability,
    previewMode: v.optional(folderPreviewMode),
    previewSource: v.optional(v.string()),
    // Undefined inherits the gallery's thumbnail ordering.
    sortOrder: v.optional(gallerySortOrder),
    filesystemIdentity: v.optional(v.string()),
    filesystemSyncId: v.optional(v.string()),
    filesystemMissingAt: v.optional(v.number()),
  })
    .index("by_galleryId_and_parentId", ["galleryId", "parentId"])
    .index("by_galleryId_and_parentId_and_name", [
      "galleryId",
      "parentId",
      "name",
    ])
    .index("by_galleryId_and_parentId_and_slug", [
      "galleryId",
      "parentId",
      "slug",
    ])
    .index("by_galleryId_and_parentId_and_filesystemIdentity", [
      "galleryId",
      "parentId",
      "filesystemIdentity",
    ])
    .index("by_galleryId", ["galleryId"]),

  galleryRoles: defineTable({
    galleryId: v.id("galleries"),
    folderId: v.optional(v.id("folders")),
    profileId: v.id("profiles"),
    role: galleryRole,
  })
    .index("by_galleryId_and_profileId", ["galleryId", "profileId"])
    .index("by_galleryId_and_folderId", ["galleryId", "folderId"])
    .index("by_galleryId_and_role", ["galleryId", "role"])
    .index("by_profileId", ["profileId"]),

  entries: defineTable({
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
    ownerProfileId: v.id("profiles"),
    uploadIntentId: v.optional(v.id("uploadIntents")),
    // Set when a gallery owner adopts a filesystem-discovered item. The
    // one-off Unknown-uploader backfill leaves claimed items untouched.
    filesystemOwnershipClaimed: v.optional(v.boolean()),
    name: v.string(),
    // Lower-cased name; image galleries keep it unique within a folder.
    nameKey: v.string(),
    description: v.optional(v.string()),
    mimeType: v.string(),
    extension: v.string(),
    mediaKind,
    size: v.number(),
    sha256: v.string(),
    // The containing folder's subtree key (see lib/folderPath.ts), letting
    // recursive folder previews range-scan a whole subtree's entries. Absent
    // on entries created before the feature; enabling it backfills the key.
    folderPathKey: v.optional(v.string()),
    storageKind,
    storageKey: v.string(),
    thumbnailKey: v.optional(v.string()),
    thumbnailState: v.optional(thumbnailState),
    previewKey: v.optional(v.string()),
    previewError: v.optional(v.string()),
    metadataJson: v.optional(v.string()),
    metadataVersion: v.optional(v.number()),
    filesystemModifiedAt: v.optional(v.number()),
    // Stable fallback for date sorting. Unlike updatedAt, metadata refreshes
    // and renames do not change it.
    sortFallbackTimestamp: v.optional(v.number()),
    // Date taken when metadata provides it; otherwise filesystem modified
    // time, then upload time. Denormalized so date sorting can paginate.
    sortTimestamp: v.optional(v.number()),
    filesystemIdentity: v.optional(v.string()),
    filesystemSyncId: v.optional(v.string()),
    passwordSalt: v.optional(v.string()),
    passwordHash: v.optional(v.string()),
    passwordIterations: v.optional(v.number()),
    unlisted: v.optional(v.boolean()),
    state: entryState,
    moveJobId: v.optional(v.id("entryMoveJobs")),
    filesystemOperationId: v.optional(v.id("filesystemOperations")),
    migrationState: v.optional(
      v.union(v.literal("moving"), v.literal("failed")),
    ),
    migrationClaimedAt: v.optional(v.number()),
    migrationAttempts: v.optional(v.number()),
    migrationRetryAt: v.optional(v.number()),
    migrationError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    deletedAt: v.optional(v.number()),
  })
    .index("by_folderId_and_state", ["folderId", "state"])
    .index("by_folderId_and_filesystemIdentity", ["folderId", "filesystemIdentity"])
    .index("by_folderId_and_state_and_nameKey", ["folderId", "state", "nameKey"])
    .index("by_folderId_and_state_and_moveJobId_and_createdAt", [
      "folderId",
      "state",
      "moveJobId",
      "createdAt",
    ])
    .index("by_folderId_and_state_and_moveJobId_and_nameKey", [
      "folderId",
      "state",
      "moveJobId",
      "nameKey",
    ])
    .index("by_folderId_and_state_and_moveJobId_and_size", [
      "folderId",
      "state",
      "moveJobId",
      "size",
    ])
    .index("by_folderId_and_state_and_moveJobId_and_sortTimestamp", [
      "folderId",
      "state",
      "moveJobId",
      "sortTimestamp",
    ])
    .index("by_folderId_and_state_and_moveJobId_and_name", [
      "folderId",
      "state",
      "moveJobId",
      "name",
    ])
    .index(
      "by_folderImages_nameKey",
      ["folderId", "state", "mediaKind", "moveJobId", "nameKey"],
    )
    .index(
      "by_folderImages_sha256",
      ["folderId", "state", "mediaKind", "moveJobId", "sha256"],
    )
    .index("by_galleryId_and_state", ["galleryId", "state"])
    // Subtree preview scans: a folderPathKey prefix range walks every
    // descendant folder's images (path order, then filename) in one query.
    // Named for purpose, not fields: the full spelling exceeds Convex's
    // 64-character identifier limit.
    .index("by_subtreeImages", [
      "galleryId",
      "state",
      "mediaKind",
      "moveJobId",
      "folderPathKey",
      "nameKey",
    ])
    // Custom preview filenames resolved across a subtree.
    .index("by_subtreeNameKey", [
      "galleryId",
      "state",
      "nameKey",
      "moveJobId",
      "folderPathKey",
    ])
    .index("by_state_and_mediaKind_and_metadataVersion", [
      "state",
      "mediaKind",
      "metadataVersion",
    ])
    .index("by_galleryId_and_storageKind", ["galleryId", "storageKind"])
    .index("by_galleryId_and_storageKind_and_state", [
      "galleryId",
      "storageKind",
      "state",
    ])
    .index("by_uploadIntentId", ["uploadIntentId"])
    .index("by_storageKey", ["storageKey"])
    .index("by_thumbnailKey", ["thumbnailKey"])
    .index("by_previewKey", ["previewKey"])
    .index("by_ownerProfileId", ["ownerProfileId"]),

  filesystemSyncStates: defineTable({
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
    knownModifiedAt: v.optional(v.number()),
    activeSyncId: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    lastCheckedAt: v.optional(v.number()),
    lastCompletedAt: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index("by_folderId", ["folderId"])
    .index("by_galleryId", ["galleryId"]),

  filesystemOperations: defineTable({
    galleryId: v.id("galleries"),
    parentId: v.id("folders"),
    folderId: v.optional(v.id("folders")),
    entryId: v.optional(v.id("entries")),
    actorProfileId: v.id("profiles"),
    kind: v.union(
      v.literal("mkdir"),
      v.literal("rename"),
      v.literal("rmdir"),
      v.literal("fileRename"),
      v.literal("move"),
    ),
    name: v.string(),
    // Settings for the folder a mkdir operation creates on completion. Only
    // mkdir carries them: every other kind targets an existing folder whose
    // settings are edited directly, so a snapshot here would go stale while
    // the operation is pending.
    accessPolicy: v.optional(folderAccessPolicy),
    discoverability: v.optional(folderDiscoverability),
    previewMode: v.optional(folderPreviewMode),
    previewSource: v.optional(v.string()),
    tokenHash: v.string(),
    expiresAt: v.number(),
    state: uploadState,
    error: v.optional(v.string()),
    attempts: v.optional(v.number()),
    claimedAt: v.optional(v.number()),
    leaseExpiresAt: v.optional(v.number()),
  })
    .index("by_state", ["state"])
    .index("by_state_and_expiresAt", ["state", "expiresAt"])
    .index("by_state_and_leaseExpiresAt", ["state", "leaseExpiresAt"])
    .index("by_galleryId", ["galleryId"])
    .index("by_actorProfileId", ["actorProfileId"]),

  entryCounters: defineTable({
    entryId: v.id("entries"),
    galleryId: v.id("galleries"),
    views: v.number(),
    downloads: v.number(),
  })
    .index("by_entryId", ["entryId"])
    .index("by_galleryId", ["galleryId"]),

  uploadIntents: defineTable({
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
    ownerProfileId: v.id("profiles"),
    name: v.string(),
    description: v.optional(v.string()),
    declaredMimeType: v.string(),
    declaredSize: v.number(),
    removeLocationData: v.optional(v.boolean()),
    unlisted: v.optional(v.boolean()),
    conflictPolicy: v.optional(conflictPolicy),
    // Name chosen at claim time once conflicts are resolved; the entry is
    // created under it. Absent until the storage server claims the upload.
    resolvedName: v.optional(v.string()),
    tokenHash: v.string(),
    passwordSalt: v.optional(v.string()),
    passwordHash: v.optional(v.string()),
    passwordIterations: v.optional(v.number()),
    expiresAt: v.number(),
    state: uploadState,
    error: v.optional(v.string()),
    attempts: v.optional(v.number()),
    claimedAt: v.optional(v.number()),
    leaseExpiresAt: v.optional(v.number()),
  })
    .index("by_galleryId", ["galleryId"])
    .index("by_folderId_and_state", ["folderId", "state"])
    .index("by_ownerProfileId", ["ownerProfileId"])
    .index("by_state", ["state"])
    .index("by_state_and_expiresAt", ["state", "expiresAt"])
    .index("by_state_and_leaseExpiresAt", ["state", "leaseExpiresAt"]),

  downloadTickets: defineTable({
    entryId: v.id("entries"),
    tokenHash: v.string(),
    disposition,
    expiresAt: v.number(),
    claimedAt: v.optional(v.number()),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_expiresAt", ["expiresAt"]),

  storageDeleteJobs: defineTable({
    entryId: v.id("entries"),
    storageKey: v.string(),
    thumbnailKey: v.optional(v.string()),
    previewKey: v.optional(v.string()),
    deleteOriginal: v.optional(v.boolean()),
    deleteEntry: v.boolean(),
    status: jobState,
    error: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
    attempts: v.optional(v.number()),
    availableAt: v.optional(v.number()),
    leaseExpiresAt: v.optional(v.number()),
  })
    .index("by_status", ["status"])
    .index("by_status_and_availableAt", ["status", "availableAt"])
    .index("by_status_and_leaseExpiresAt", ["status", "leaseExpiresAt"])
    .index("by_entryId", ["entryId"]),

  entryMoveJobs: defineTable({
    entryId: v.id("entries"),
    sourceGalleryId: v.id("galleries"),
    destinationGalleryId: v.id("galleries"),
    destinationFolderId: v.id("folders"),
    actorProfileId: v.id("profiles"),
    bulkOperationId: v.optional(v.id("bulkOperations")),
    expectedSourceStorageKey: v.string(),
    conflictPolicy: v.optional(conflictPolicy),
    // Name the entry takes in the destination when auto-renamed; absent
    // means it keeps its own name.
    targetName: v.optional(v.string()),
    status: entryMoveJobState,
    attempts: v.number(),
    availableAt: v.number(),
    claimedAt: v.optional(v.number()),
    leaseExpiresAt: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index("by_status_and_availableAt", ["status", "availableAt"])
    .index("by_status_and_leaseExpiresAt", ["status", "leaseExpiresAt"])
    .index("by_entryId", ["entryId"])
    .index("by_actorProfileId", ["actorProfileId"])
    .index("by_destinationFolderId_and_status", [
      "destinationFolderId",
      "status",
    ])
    .index("by_bulkOperationId_and_status", ["bulkOperationId", "status"]),

  bulkOperations: defineTable({
    actorProfileId: v.id("profiles"),
    kind: v.union(v.literal("delete"), v.literal("move")),
    sourceGalleryId: v.id("galleries"),
    sourceFolderId: v.id("folders"),
    selectionKind: v.union(v.literal("ids"), v.literal("folder")),
    entryIds: v.optional(v.array(v.id("entries"))),
    excludedEntryIds: v.optional(v.array(v.id("entries"))),
    destinationGalleryId: v.optional(v.id("galleries")),
    destinationFolderId: v.optional(v.id("folders")),
    cutoffCreatedAt: v.number(),
    cursor: v.optional(v.string()),
    nextIndex: v.number(),
    discoveryComplete: v.boolean(),
    status: bulkOperationStatus,
    totalItems: v.number(),
    completedItems: v.number(),
    failedItems: v.number(),
    // Items parked on a name conflict until a policy resolves them.
    conflictItems: v.number(),
    // Once set, conflicts found later in this operation resolve themselves.
    conflictPolicy: v.optional(bulkConflictPolicy),
    error: v.optional(v.string()),
    dismissedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_actorProfileId_and_createdAt", ["actorProfileId", "createdAt"])
    .index("by_status_and_createdAt", ["status", "createdAt"])
    // Undismissed rows sort first (dismissedAt unset), so the auto-dismiss
    // sweep reads only what it still has to touch.
    .index("by_dismissedAt_and_status_and_updatedAt", [
      "dismissedAt",
      "status",
      "updatedAt",
    ]),

  storageMigrations: defineTable({
    galleryId: v.id("galleries"),
    sourceStorageKind: storageKind,
    targetStorageKind: storageKind,
    targetStorageRoot: v.string(),
    status: jobState,
    movedItems: v.number(),
    failedItems: v.number(),
    error: v.optional(v.string()),
  })
    .index("by_status", ["status"])
    .index("by_galleryId", ["galleryId"]),

  filesystemSyncJobs: defineTable({
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
    status: jobState,
    attempts: v.number(),
    availableAt: v.number(),
    claimedAt: v.optional(v.number()),
    leaseExpiresAt: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index("by_status", ["status"])
    .index("by_status_and_availableAt", ["status", "availableAt"])
    .index("by_status_and_leaseExpiresAt", ["status", "leaseExpiresAt"])
    .index("by_folderId", ["folderId"])
    .index("by_galleryId_and_status", ["galleryId", "status"]),

  mediaProcessingJobs: defineTable({
    entryId: v.id("entries"),
    expectedStorageKey: v.string(),
    expectedSha256: v.string(),
    status: jobState,
    attempts: v.number(),
    availableAt: v.number(),
    claimedAt: v.optional(v.number()),
    leaseExpiresAt: v.optional(v.number()),
    error: v.optional(v.string()),
    processorVersion: v.optional(v.number()),
    previewRequested: v.optional(v.boolean()),
    removeLocationData: v.optional(v.boolean()),
  })
    .index("by_status", ["status"])
    .index("by_status_and_processorVersion", ["status", "processorVersion"])
    .index("by_status_and_availableAt", ["status", "availableAt"])
    .index("by_status_and_leaseExpiresAt", ["status", "leaseExpiresAt"])
    .index("by_entryId", ["entryId"]),

  fileTypeIcons: defineTable({
    // Optional only so deployments containing legacy system-wide overrides can
    // adopt the per-gallery index without a blocking data migration.
    galleryId: v.optional(v.id("galleries")),
    extension: v.string(),
    label: v.string(),
    icon: v.string(),
    thumbnailUrl: v.optional(v.string()),
  }).index("by_galleryId_and_extension", ["galleryId", "extension"]),

  // One row per storage process, refreshed on an interval, so the admin
  // System panel can show container liveness and the running build's commit.
  serviceHeartbeats: defineTable({
    component: v.string(),
    commit: v.optional(v.string()),
    at: v.number(),
  }).index("by_component", ["component"]),

  auditEvents: defineTable({
    actorProfileId: v.optional(v.id("profiles")),
    action: v.string(),
    galleryId: v.optional(v.id("galleries")),
    detail: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_galleryId", ["galleryId"])
    .index("by_actorProfileId", ["actorProfileId"]),
});
