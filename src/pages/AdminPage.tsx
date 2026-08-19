import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import { ExternalLink, Plus } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { PageFrame } from "../components/PageFrame";
import { formatBytes } from "../lib/files";
import { friendlyError } from "../lib/errors";
import { anonymousClaim } from "../lib/authClient";
import {
  THEME_MODE_DEFAULTS,
  type ThemeMode,
} from "../lib/theme";
import {
  firstPrefixAttempt,
  galleryNamePathSegment,
  generatedGalleryFields,
  nextPrefixAttempt,
  type PrefixAttempt,
} from "../lib/galleryDraft";
import {
  buildTheme,
  diffGallerySettings,
  initialThemeJson,
  mibValue,
  type SettingsSnapshot,
  type UploaderAccess,
} from "../lib/gallerySettings";
import styles from "../styles/admin.module.css";
import layout from "../styles/layout.module.css";

type GalleryKind = "image" | "uploader";
type StorageKind = "shared" | "user";
type FolderPreviewMode = "first" | "random" | "first3" | "random3";

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timeout);
  }, [delayMs, value]);
  return debounced;
}

export function AdminPage() {
  const profile = useQuery(api.profiles.current, {
    anonymousClaim: anonymousClaim(),
  });
  const galleries = useQuery(api.galleries.listManaged);
  const [searchParams, setSearchParams] = useSearchParams();
  const [selected, setSelected] = useState<Id<"galleries"> | null>(null);

  useEffect(() => {
    if (
      galleries !== undefined &&
      (selected === null || !galleries.some((gallery) => gallery._id === selected))
    ) {
      const requested = searchParams.get("gallery");
      setSelected(
        galleries.find((gallery) => gallery._id === requested)?._id ??
          galleries[0]?._id ??
          null,
      );
    }
  }, [galleries, searchParams, selected]);

  const selectGallery = (id: Id<"galleries">) => {
    setSelected(id);
    setSearchParams({ gallery: id }, { replace: true });
  };

  if (profile === undefined || galleries === undefined) {
    return <PageFrame><p>Loading administration…</p></PageFrame>;
  }
  if (profile === null || profile.isAnonymous) {
    return (
      <PageFrame>
        <div className={styles.centered}>
          <h1>Administration</h1>
          <p>Log in with Google to continue.</p>
        </div>
      </PageFrame>
    );
  }
  if (!profile.isSystemAdmin && galleries.length === 0) {
    return (
      <PageFrame>
        <div className={styles.centered}>
          <h1>Administration</h1>
          <p>Your account does not manage any galleries.</p>
        </div>
      </PageFrame>
    );
  }

  return (
    <PageFrame>
      <div className={styles.adminLayout}>
        <aside className={styles.sidebar}>
          <h1>Administration</h1>
          <nav>
            {galleries.map((gallery) => (
              <button
                type="button"
                key={gallery._id}
                className={selected === gallery._id ? styles.selected : ""}
                onClick={() => selectGallery(gallery._id)}
              >
                <span>{gallery.name}</span>
                <small>{gallery.kind}</small>
              </button>
            ))}
          </nav>
          {profile.isSystemAdmin ? <CreateGallery onCreated={selectGallery} /> : null}
        </aside>
        <section className={styles.content}>
          {selected ? (
            <GalleryAdmin
              galleryId={selected}
              isSystemAdmin={profile.isSystemAdmin}
            />
          ) : (
            <p>Create a gallery to get started.</p>
          )}
          {profile.isSystemAdmin ? <SystemSection /> : null}
        </section>
      </div>
    </PageFrame>
  );
}

function CreateGallery(props: {
  onCreated: (id: Id<"galleries">) => void;
}) {
  const create = useMutation(api.galleries.create);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<GalleryKind>("image");
  const [storageKind, setStorageKind] = useState<StorageKind>("shared");
  const [autoPrefix, setAutoPrefix] = useState<PrefixAttempt>(() =>
    firstPrefixAttempt(),
  );
  const [autoNameSegment, setAutoNameSegment] = useState("");
  const [slugOverride, setSlugOverride] = useState<string | null>(null);
  const [storageRootOverride, setStorageRootOverride] = useState<string | null>(
    null,
  );
  const [rootPathOverride, setRootPathOverride] = useState<string | null>(null);

  const debouncedName = useDebouncedValue(name, 400);
  const generated = generatedGalleryFields(autoNameSegment, autoPrefix.prefix);
  const slug = slugOverride ?? generated.slug;
  const storageRoot = storageRootOverride ?? generated.storageRoot;
  const rootPath = rootPathOverride ?? generated.rootPath;
  const debouncedSlug = useDebouncedValue(slug, 400);
  const debouncedStorageRoot = useDebouncedValue(storageRoot, 400);
  const validationSlug = slugOverride === null ? slug : debouncedSlug;
  const validationStorageRoot =
    storageRootOverride === null ? storageRoot : debouncedStorageRoot;
  const availability = useQuery(
    api.galleries.checkAvailability,
    validationSlug.length > 0
      ? { slug: validationSlug, storageRoot: validationStorageRoot }
      : "skip",
  );

  useEffect(() => {
    if (slugOverride !== null) return;
    setAutoNameSegment(galleryNamePathSegment(debouncedName));
    setAutoPrefix(firstPrefixAttempt());
  }, [debouncedName, slugOverride]);

  useEffect(() => {
    if (
      slugOverride !== null ||
      availability === undefined ||
      availability.normalizedSlug !== slug ||
      availability.normalizedStorageRoot !== storageRoot
    ) {
      return;
    }
    const generatedSlugTaken = !availability.slugAvailable;
    const generatedStorageRootTaken =
      storageRootOverride === null && !availability.storageRootAvailable;
    if (generatedSlugTaken || generatedStorageRootTaken) {
      setAutoPrefix((current) => nextPrefixAttempt(current));
    }
  }, [
    availability,
    slug,
    slugOverride,
    storageRoot,
    storageRootOverride,
  ]);

  const reset = () => {
    setError(null);
    setName("");
    setKind("image");
    setStorageKind("shared");
    setAutoNameSegment("");
    setAutoPrefix(firstPrefixAttempt());
    setSlugOverride(null);
    setStorageRootOverride(null);
    setRootPathOverride(null);
  };

  const manualSlugSettled = slugOverride === null || slug === debouncedSlug;
  const manualStorageRootSettled =
    storageRootOverride === null || storageRoot === debouncedStorageRoot;
  const automaticNameSettled =
    slugOverride !== null || name === debouncedName;
  const slugValidationError =
    slugOverride !== null && manualSlugSettled && slug.length === 0
      ? "Internal slug is required."
      : slugOverride !== null && manualSlugSettled && availability !== undefined
        ? availability.normalizedSlug === null
          ? "Internal slug must contain between 2 and 80 URL-safe characters."
          : !availability.slugAvailable
            ? "This internal slug is already in use."
            : null
        : null;
  const storageRootValidationError =
    storageRootOverride !== null &&
    manualStorageRootSettled &&
    availability !== undefined
      ? availability.normalizedStorageRoot === null
        ? "Internal storage path must be a valid relative path."
        : !availability.storageRootAvailable
          ? "This internal storage path is already in use."
          : null
      : null;
  const availableToCreate =
    automaticNameSettled &&
    manualSlugSettled &&
    manualStorageRootSettled &&
    availability?.slugAvailable === true &&
    availability.storageRootAvailable;

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void create({
      name,
      slug,
      kind,
      storageKind,
      storageRoot,
      hosts: [
        {
          host: String(form.get("host")),
          rootPath,
        },
      ],
    })
      .then((id) => {
        props.onCreated(id);
        reset();
        setOpen(false);
      })
      .catch((reason: unknown) =>
        setError(friendlyError(reason, "Could not create")),
      );
  };
  return open ? (
    <form className={`${layout.form} ${styles.createForm}`} onSubmit={submit}>
      <h2>New upgallery</h2>
      <label>Name<input name="name" required value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>
        Internal slug
        <input
          name="slug"
          required
          placeholder="a7-family-photos"
          value={slug}
          aria-invalid={slugValidationError !== null}
          onChange={(event) => {
            if (slugOverride === null) {
              setStorageRootOverride(storageRoot);
              setRootPathOverride(rootPath);
            }
            setSlugOverride(event.target.value);
          }}
        />
        {slugValidationError ? <span className={layout.formError}>{slugValidationError}</span> : null}
      </label>
      <label>Kind<select name="kind" value={kind} onChange={(event) => {
        const nextKind = event.target.value as GalleryKind;
        setKind(nextKind);
        if (nextKind === "uploader") setStorageKind("shared");
      }}><option value="image">Image gallery</option><option value="uploader">Uploader</option></select></label>
      <label>Storage<select name="storageKind" value={storageKind} onChange={(event) => setStorageKind(event.target.value as StorageKind)}><option value="shared">Shared</option><option value="user" disabled={kind === "uploader"}>User mount</option></select></label>
      <label>
        Internal storage path
        <input
          name="storageRoot"
          required
          placeholder="a7-family-photos"
          value={storageRoot}
          aria-invalid={storageRootValidationError !== null}
          onChange={(event) => setStorageRootOverride(event.target.value)}
        />
        {storageRootValidationError ? <span className={layout.formError}>{storageRootValidationError}</span> : null}
      </label>
      <label>Domain<input name="host" required placeholder="photos.example.com" /></label>
      <label>Public URL path<input name="rootPath" required value={rootPath} onChange={(event) => setRootPathOverride(event.target.value)} /></label>
      {error ? <p className={layout.formError}>{error}</p> : null}
      <div className={layout.buttonRow}><button type="submit" disabled={!availableToCreate}>Create</button><button type="button" onClick={() => { reset(); setOpen(false); }}>Cancel</button></div>
    </form>
  ) : (
    <button type="button" className={styles.newButton} onClick={() => { reset(); setOpen(true); }}>
      <Plus aria-hidden="true" size={16} /> New upgallery
    </button>
  );
}

function publicGalleryUrl(
  hosts: Array<{ host: string; rootPath: string }>,
): string | null {
  const route = hosts.find((entry) => entry.rootPath === "/") ?? hosts[0];
  if (route === undefined) {
    return null;
  }
  // Stored hosts are normalized without a port; keep the current port when the
  // route points at the host the admin panel is already served from.
  const currentHost = window.location.host
    .toLocaleLowerCase()
    .replace(/:\d+$/, "");
  const host = route.host === currentHost ? window.location.host : route.host;
  return `${window.location.protocol}//${host}${route.rootPath}`;
}

function GalleryAdmin(props: {
  galleryId: Id<"galleries">;
  isSystemAdmin: boolean;
}) {
  const details = useQuery(api.galleries.adminDetails, {
    galleryId: props.galleryId,
  });
  const remove = useMutation(api.galleries.remove);
  const upsertRole = useMutation(api.roles.upsert);
  const revokeRole = useMutation(api.roles.revoke);
  const requestMigration = useMutation(api.migrations.request);
  const [message, setMessage] = useState<string | null>(null);

  if (details === undefined) return <p>Loading gallery…</p>;
  if (details === null) return <p>Gallery no longer exists.</p>;
  const gallery = details.gallery;
  const publicUrl = publicGalleryUrl(details.hosts);

  return (
    <>
      <div className={styles.galleryHeading}>
        <div>
          <span className={styles.eyebrow}>{gallery.kind}</span>
          <h2>{gallery.name}</h2>
        </div>
        {publicUrl === null ? (
          <Link to={`/${gallery.kind === "image" ? "g" : "up"}/${gallery.slug}`}>
            Open <ExternalLink aria-hidden="true" size={15} />
          </Link>
        ) : (
          <a href={publicUrl}>
            Open <ExternalLink aria-hidden="true" size={15} />
          </a>
        )}
      </div>
      <div className={styles.stats}>
        <Stat label="Items" value={gallery.itemCount.toLocaleString()} />
        <Stat label="Storage" value={formatBytes(gallery.totalBytes)} />
        <Stat label="Backend" value={`${gallery.storageKind}/${gallery.storageRoot}`} />
      </div>
      {message ? <p className={message.startsWith("Error") ? layout.errorNotice : layout.notice}>{message}</p> : null}

      <Section title="Settings">
        <GallerySettingsForm
          key={gallery._id}
          gallery={gallery}
          hosts={details.hosts}
          isSystemAdmin={props.isSystemAdmin}
          setMessage={setMessage}
        />
      </Section>

      <FileIconAdmin galleryId={gallery._id} setMessage={setMessage} />

      <Section title="Permissions">
        <p>
          Granting access to an email that has never signed in creates an
          invite; it takes effect the first time that user signs in with
          Google.
        </p>
        <form
          className={styles.inlineForm}
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            void upsertRole({
              galleryId: gallery._id,
              email: String(data.get("email")),
              folderId:
                String(data.get("folderId") || "") === ""
                  ? undefined
                  : (String(data.get("folderId")) as Id<"folders">),
              role: data.get("role") as "owner" | "editor" | "viewer",
            })
              .then(() => {
                event.currentTarget.reset();
                setMessage("Permission saved");
              })
              .catch(showError(setMessage));
          }}
        >
          <input name="email" type="email" placeholder="User email" required />
          <select name="role"><option value="viewer">Viewer</option><option value="editor">Editor</option><option value="owner">Owner</option></select>
          <input name="folderId" placeholder="Folder ID (blank = whole gallery)" />
          <button type="submit">Grant</button>
        </form>
        <div className={styles.rows}>
          {details.grants.map((grant) => (
            <div className={styles.row} key={grant._id}>
              <span>
                {grant.profile?.email ?? grant.profile?.displayName ?? "Unknown user"}
                {grant.profile?.isPlaceholder ? <InvitedBadge invitedAt={grant.profile.invitedAt} /> : null}
              </span>
              <span>{grant.role}{grant.folderId ? " · folder scope" : " · gallery scope"}</span>
              <button type="button" onClick={() => void revokeRole({ grantId: grant._id }).catch(showError(setMessage))}>Revoke</button>
            </div>
          ))}
        </div>
      </Section>

      {gallery.kind === "image" && props.isSystemAdmin ? (
        <Section title="Storage migration">
          <form
            className={styles.inlineForm}
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void requestMigration({
                galleryId: gallery._id,
                targetStorageKind: data.get("targetStorageKind") as StorageKind,
                targetStorageRoot: String(data.get("targetStorageRoot")),
              }).then(() => setMessage("Migration queued")).catch(showError(setMessage));
            }}
          >
            <select name="targetStorageKind"><option value="shared">Shared</option><option value="user">User mount</option></select>
            <input name="targetStorageRoot" required placeholder="target/root" />
            <button type="submit" disabled={gallery.pendingMigrationId !== undefined}>Queue migration</button>
          </form>
          {details.migrations.map((migration) => (
            <p key={migration._id}><code>{migration.status}</code> · {migration.movedItems} moved · {migration.failedItems} failed {migration.error ? `· ${migration.error}` : ""}</p>
          ))}
        </Section>
      ) : null}

      <Section title="Danger zone">
        <button
          className={styles.danger}
          type="button"
          onClick={() => {
            if (window.confirm(`Delete ${gallery.name} and queue all files for deletion?`)) {
              void remove({ galleryId: gallery._id }).catch(showError(setMessage));
            }
          }}
        >
          Delete gallery
        </button>
      </Section>
    </>
  );
}

type GalleryTheme = Doc<"galleries">["theme"];

function GallerySettingsForm(props: {
  gallery: Doc<"galleries">;
  hosts: Array<Doc<"galleryHosts">>;
  isSystemAdmin: boolean;
  setMessage: (message: string | null) => void;
}) {
  const update = useMutation(api.galleries.update);
  const gallery = props.gallery;
  const [settingsDirty, setSettingsDirty] = useState(false);
  // Snapshot of the values this form was mounted with (the gallery from the
  // reactive query keeps updating; the form inputs do not). Saving diffs the
  // submitted values against the snapshot and sends only the fields changed
  // in this tab, so a long-open form cannot overwrite settings that were
  // changed elsewhere in the meantime.
  const [initialTheme] = useState<GalleryTheme>(gallery.theme);
  const [initial, setInitial] = useState<SettingsSnapshot>(() => ({
    name: gallery.name,
    maxFileSizeMib: mibValue(gallery.maxFileSize),
    maxFileSizeLimitMib: mibValue(
      gallery.maxFileSizeLimit ?? gallery.maxFileSize,
    ),
    uploaderAccess: gallery.uploaderAccess,
    folderPreviewMode: gallery.folderPreviewMode ?? "first",
    quickMove: gallery.quickMove === true,
    hosts: props.hosts
      .map((host) => `${host.host}|${host.rootPath}`)
      .join("\n"),
    themeJson: initialThemeJson(gallery.theme),
  }));

  const updateSettings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const theme = buildTheme({
      accent: String(data.get("accent") || ""),
      secondary: String(data.get("secondary") || ""),
      background: String(data.get("background") || ""),
      foreground: String(data.get("foreground") || ""),
      surface: String(data.get("surface") || ""),
      muted: String(data.get("muted") || ""),
      mode: data.get("mode") as ThemeMode,
      radius: Number(data.get("radius") || 4),
      density: data.get("density") as "compact" | "comfortable",
      thumbnailFrameSize: Number(data.get("thumbnailFrameSize") || 218),
      customCss: String(data.get("customCss") || ""),
    });
    // Fields whose controls are not rendered for this gallery or role fall
    // back to the snapshot, which marks them unchanged.
    const current: SettingsSnapshot = {
      name: String(data.get("name")),
      maxFileSizeMib: Number(data.get("maxFileSizeMib")),
      maxFileSizeLimitMib: props.isSystemAdmin
        ? Number(data.get("maxFileSizeLimitMib"))
        : initial.maxFileSizeLimitMib,
      uploaderAccess: data.get("uploaderAccess") as UploaderAccess,
      folderPreviewMode:
        gallery.kind === "image"
          ? (data.get("folderPreviewMode") as FolderPreviewMode)
          : initial.folderPreviewMode,
      quickMove:
        gallery.kind === "image"
          ? data.get("quickMove") === "on"
          : initial.quickMove,
      hosts: props.isSystemAdmin ? String(data.get("hosts")) : initial.hosts,
      themeJson: JSON.stringify(theme),
    };
    const changed = diffGallerySettings(initial, current, theme);
    if (Object.keys(changed).length === 0) {
      setSettingsDirty(false);
      props.setMessage("No changes to save");
      return;
    }
    void update({ galleryId: gallery._id, ...changed })
      .then(() => {
        setInitial(current);
        setSettingsDirty(false);
        props.setMessage("Settings saved");
      })
      .catch(showError(props.setMessage));
  };

  return (
    <form
      className={`${layout.form} ${styles.twoColumns}`}
      onChange={() => setSettingsDirty(true)}
      onSubmit={updateSettings}
    >
      <label>Name<input name="name" defaultValue={initial.name} /></label>
      <label>Maximum file size <small>{props.isSystemAdmin ? "(MiB)" : `(MiB · limit ${initial.maxFileSizeLimitMib} MiB)`}</small><input name="maxFileSizeMib" type="number" min="0.1" max={props.isSystemAdmin ? 10240 : initial.maxFileSizeLimitMib} step="0.1" required defaultValue={initial.maxFileSizeMib} /></label>
      {props.isSystemAdmin ? (
        <label>Max size limit <small>(MiB)</small><input name="maxFileSizeLimitMib" type="number" min="0.1" max="10240" step="0.1" required defaultValue={initial.maxFileSizeLimitMib} /></label>
      ) : null}
      <label>Uploader access<select name="uploaderAccess" defaultValue={initial.uploaderAccess}><option value="anonymous">Anonymous</option><option value="sso">Any Google SSO user</option><option value="restricted">Granted users only</option></select></label>
      <label>Density<select name="density" defaultValue={initialTheme.density ?? "compact"}><option value="compact">Compact</option><option value="comfortable">Comfortable</option></select></label>
      <label>Thumbnail frame width <small>(pixels)</small><input name="thumbnailFrameSize" type="number" min="96" max="512" step="1" defaultValue={initialTheme.thumbnailFrameSize ?? 218} /></label>
      {gallery.kind === "image" ? (
        <label>Folder preview default
          <select name="folderPreviewMode" defaultValue={initial.folderPreviewMode}>
            <option value="first">First image</option>
            <option value="random">Random</option>
            <option value="first3">First 3</option>
            <option value="random3">Random 3</option>
          </select>
        </label>
      ) : null}
      {gallery.kind === "image" ? (
        <label>Quick move <small>(drag items into folders without select mode)</small>
          <select name="quickMove" defaultValue={initial.quickMove ? "on" : "off"}>
            <option value="off">Off</option>
            <option value="on">On</option>
          </select>
        </label>
      ) : null}
      <ThemeControls theme={initialTheme} />
      <label>Corner radius<input name="radius" type="number" min="0" max="40" defaultValue={initialTheme.radius ?? 4} /></label>
      {props.isSystemAdmin ? (
        <label className={styles.spanTwo}>Host routes <small>(one per line: host|/public-path)</small><textarea name="hosts" rows={3} defaultValue={initial.hosts} /></label>
      ) : null}
      <label className={styles.spanTwo}>Scoped custom CSS<textarea name="customCss" rows={5} defaultValue={initialTheme.customCss ?? ""} /></label>
      <button
        className={settingsDirty ? styles.saveSettingsDirty : undefined}
        type="submit"
      >
        Save settings
      </button>
    </form>
  );
}

function ThemeControls(props: {
  theme: {
    accent?: string;
    secondary?: string;
    background?: string;
    foreground?: string;
    surface?: string;
    muted?: string;
    mode?: ThemeMode;
  };
}) {
  const [mode, setMode] = useState<ThemeMode>(props.theme.mode ?? "light");
  const defaults = THEME_MODE_DEFAULTS[mode];
  const [colors, setColors] = useState({
    accent: props.theme.accent ?? defaults.accent,
    secondary: props.theme.secondary ?? defaults.secondary,
    background: props.theme.background ?? defaults.background,
    foreground: props.theme.foreground ?? defaults.foreground,
    surface: props.theme.surface ?? defaults.surface,
    muted: props.theme.muted ?? defaults.muted,
  });

  const colorPicker = (name: keyof typeof colors, label: string) => (
    <label>
      {label}
      <input
        name={name}
        type="color"
        value={colors[name]}
        onChange={(event) => {
          const value = event.currentTarget.value;
          setColors((current) => ({
            ...current,
            [name]: value,
          }));
        }}
      />
    </label>
  );

  return (
    <>
      <label>
        Appearance
        <select
          name="mode"
          value={mode}
          onChange={(event) => {
            const nextMode = event.currentTarget.value as ThemeMode;
            setMode(nextMode);
            const nextDefaults = THEME_MODE_DEFAULTS[nextMode];
            setColors({
              accent: nextDefaults.accent,
              secondary: nextDefaults.secondary,
              background: nextDefaults.background,
              foreground: nextDefaults.foreground,
              surface: nextDefaults.surface,
              muted: nextDefaults.muted,
            });
          }}
        >
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </label>
      {colorPicker("accent", "Accent")}
      {colorPicker("secondary", "Secondary")}
      {colorPicker("background", "Background")}
      {colorPicker("foreground", "Foreground")}
      {colorPicker("surface", "Surface")}
      {colorPicker("muted", "Muted")}
    </>
  );
}

// System-level administration, only rendered for system admins. Everything
// above this divider is per-gallery ("user admin") configuration that gallery
// owners can also see; new system-wide options belong inside this section.
function SystemSection() {
  return (
    <div className={styles.systemSection}>
      <h2 className={styles.systemHeading}>System</h2>
      <SystemUsers />
    </div>
  );
}

function SystemUsers() {
  const users = useQuery(api.profiles.listForAdmin);
  const setAdmin = useMutation(api.profiles.setSystemAdmin);
  if (users === undefined) return null;
  return (
    <Section title="Users">
      <div className={styles.rows}>
        {users.filter((user) => !user.isAnonymous).map((user) => (
          <div className={styles.row} key={user._id}>
            <span>
              {user.email ?? user.displayName}
              {user.isPlaceholder ? <InvitedBadge invitedAt={user.invitedAt} /> : null}
            </span>
            <span>{user.isSystemAdmin ? "Administrator" : user.isPlaceholder ? "Awaiting first sign-in" : "User"}</span>
            {user.isPlaceholder ? <span /> : (
              <button type="button" onClick={() => void setAdmin({ profileId: user._id, enabled: !user.isSystemAdmin })}>{user.isSystemAdmin ? "Remove admin" : "Make admin"}</button>
            )}
          </div>
        ))}
      </div>
    </Section>
  );
}

function FileIconAdmin(props: {
  galleryId: Id<"galleries">;
  setMessage: (value: string) => void;
}) {
  const icons = useQuery(api.fileTypeIcons.list, {
    galleryId: props.galleryId,
  });
  const upsert = useMutation(api.fileTypeIcons.upsert);
  const remove = useMutation(api.fileTypeIcons.remove);
  if (icons === undefined) return null;
  return (
    <Section title="File-type thumbnails">
      <p>
        Add an override for this gallery. Removing it restores the bundled
        default.
      </p>
      <form
        className={styles.inlineForm}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void upsert({
            galleryId: props.galleryId,
            extension: String(data.get("extension")),
            label: String(data.get("label")),
            icon: String(data.get("icon")),
            thumbnailUrl: String(data.get("thumbnailUrl") || "") || undefined,
          })
            .then(() => {
              event.currentTarget.reset();
              props.setMessage("File-type override saved");
            })
            .catch(showError(props.setMessage));
        }}
      >
        <input name="extension" placeholder="ext" required />
        <input name="label" placeholder="Label" required />
        <input name="icon" placeholder="Text fallback" required />
        <input name="thumbnailUrl" placeholder="Optional thumbnail URL" />
        <button type="submit">Save</button>
      </form>
      <div className={styles.rows}>
        {icons.map((icon) => (
          <div className={styles.row} key={icon._id}>
            <span className={styles.iconSummary}>
              {icon.thumbnailUrl ? (
                <img src={icon.thumbnailUrl} alt="" />
              ) : (
                <span className={styles.iconText}>{icon.icon}</span>
              )}
              <span>.{icon.extension} · {icon.label}</span>
            </span>
            <span>{icon.thumbnailUrl ?? "Text-only override"}</span>
            <button
              type="button"
              onClick={() =>
                void remove({ iconId: icon._id })
                  .then(() => props.setMessage("Default restored"))
                  .catch(showError(props.setMessage))
              }
            >
              Restore default
            </button>
          </div>
        ))}
      </div>
    </Section>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return <section className={styles.section}><h3>{props.title}</h3>{props.children}</section>;
}

function Stat(props: { label: string; value: string }) {
  return <div><small>{props.label}</small><strong>{props.value}</strong></div>;
}

function InvitedBadge(props: { invitedAt?: number }) {
  return (
    <em
      className={styles.pendingBadge}
      title={
        props.invitedAt === undefined
          ? undefined
          : `Invited ${new Date(props.invitedAt).toLocaleString()}`
      }
    >
      invited
    </em>
  );
}

function showError(setter: (value: string) => void) {
  return (reason: unknown) =>
    setter(`Error: ${friendlyError(reason)}`);
}
