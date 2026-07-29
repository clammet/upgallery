import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  disposition,
  entryState,
  galleryKind,
  galleryRole,
  jobState,
  mediaKind,
  privacy,
  storageKind,
  themeValidator,
  uploaderAccess,
  uploadState,
} from "./lib/validators";

export default defineSchema({
  profiles: defineTable({
    googleSubject: v.optional(v.string()),
    displayName: v.optional(v.string()),
    email: v.optional(v.string()),
    image: v.optional(v.string()),
    isAnonymous: v.boolean(),
    isSystemAdmin: v.boolean(),
    anonymousClaimHash: v.optional(v.string()),
    mergedIntoProfileId: v.optional(v.id("profiles")),
    lastSeenAt: v.number(),
  })
    .index("by_googleSubject", ["googleSubject"])
    .index("by_email", ["email"])
    .index("by_anonymousClaimHash", ["anonymousClaimHash"]),

  profileAliases: defineTable({
    sourceProfileId: v.id("profiles"),
    targetProfileId: v.id("profiles"),
  })
    .index("by_sourceProfileId", ["sourceProfileId"])
    .index("by_targetProfileId", ["targetProfileId"]),

  googleAuthSessions: defineTable({
    sessionToken: v.string(),
    refreshToken: v.string(),
    googleSubject: v.string(),
    createdAt: v.number(),
  })
    .index("by_sessionToken", ["sessionToken"])
    .index("by_googleSubject", ["googleSubject"]),

  galleries: defineTable({
    name: v.string(),
    slug: v.string(),
    kind: galleryKind,
    storageKind,
    storageRoot: v.string(),
    maxFileSize: v.number(),
    uploaderAccess,
    rootFolderId: v.optional(v.id("folders")),
    theme: themeValidator,
    itemCount: v.number(),
    totalBytes: v.number(),
    pendingMigrationId: v.optional(v.id("storageMigrations")),
    deletedAt: v.optional(v.number()),
  }).index("by_slug", ["slug"]),

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
    privacy,
    filesystemIdentity: v.optional(v.string()),
    filesystemSyncId: v.optional(v.string()),
    filesystemMissingAt: v.optional(v.number()),
  })
    .index("by_galleryId_and_parentId", ["galleryId", "parentId"])
    .index("by_galleryId", ["galleryId"]),

  galleryRoles: defineTable({
    galleryId: v.id("galleries"),
    folderId: v.optional(v.id("folders")),
    profileId: v.id("profiles"),
    role: galleryRole,
  })
    .index("by_galleryId_and_profileId", ["galleryId", "profileId"])
    .index("by_galleryId_and_folderId", ["galleryId", "folderId"])
    .index("by_profileId", ["profileId"]),

  entries: defineTable({
    galleryId: v.id("galleries"),
    folderId: v.id("folders"),
    ownerProfileId: v.id("profiles"),
    uploadIntentId: v.optional(v.id("uploadIntents")),
    name: v.string(),
    description: v.optional(v.string()),
    mimeType: v.string(),
    extension: v.string(),
    mediaKind,
    size: v.number(),
    sha256: v.string(),
    storageKind,
    storageKey: v.string(),
    thumbnailKey: v.optional(v.string()),
    metadataJson: v.optional(v.string()),
    filesystemModifiedAt: v.optional(v.number()),
    filesystemIdentity: v.optional(v.string()),
    filesystemSyncId: v.optional(v.string()),
    passwordSalt: v.optional(v.string()),
    passwordHash: v.optional(v.string()),
    passwordIterations: v.optional(v.number()),
    state: entryState,
    moveJobId: v.optional(v.id("entryMoveJobs")),
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
    .index("by_galleryId_and_state", ["galleryId", "state"])
    .index("by_galleryId_and_storageKind", ["galleryId", "storageKind"])
    .index("by_galleryId_and_storageKind_and_state", [
      "galleryId",
      "storageKind",
      "state",
    ])
    .index("by_uploadIntentId", ["uploadIntentId"])
    .index("by_storageKey", ["storageKey"])
    .index("by_thumbnailKey", ["thumbnailKey"])
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
    actorProfileId: v.id("profiles"),
    kind: v.union(v.literal("mkdir"), v.literal("rename")),
    name: v.string(),
    privacy,
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
    .index("by_galleryId", ["galleryId"]),

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
    .index("by_state", ["state"])
    .index("by_state_and_expiresAt", ["state", "expiresAt"])
    .index("by_state_and_leaseExpiresAt", ["state", "leaseExpiresAt"]),

  downloadTickets: defineTable({
    entryId: v.id("entries"),
    tokenHash: v.string(),
    disposition,
    expiresAt: v.number(),
    claimedAt: v.optional(v.number()),
  }).index("by_tokenHash", ["tokenHash"]),

  storageDeleteJobs: defineTable({
    entryId: v.id("entries"),
    storageKey: v.string(),
    thumbnailKey: v.optional(v.string()),
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
    expectedSourceStorageKey: v.string(),
    status: jobState,
    attempts: v.number(),
    availableAt: v.number(),
    claimedAt: v.optional(v.number()),
    leaseExpiresAt: v.optional(v.number()),
    error: v.optional(v.string()),
  })
    .index("by_status_and_availableAt", ["status", "availableAt"])
    .index("by_status_and_leaseExpiresAt", ["status", "leaseExpiresAt"])
    .index("by_entryId", ["entryId"]),

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
    .index("by_folderId", ["folderId"]),

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
  })
    .index("by_status", ["status"])
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
