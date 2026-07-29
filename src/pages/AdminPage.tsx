import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { PageFrame } from "../components/PageFrame";
import { formatBytes } from "../lib/files";
import { friendlyError } from "../lib/errors";
import { getOrCreateAnonymousClaim } from "../lib/anonymousClaim";
import styles from "../styles/admin.module.css";
import layout from "../styles/layout.module.css";

type GalleryKind = "image" | "uploader";
type StorageKind = "shared" | "user";

export function AdminPage() {
  const profile = useQuery(api.profiles.current, {
    anonymousClaim: getOrCreateAnonymousClaim(),
  });
  const galleries = useQuery(api.galleries.listManaged);
  const [selected, setSelected] = useState<Id<"galleries"> | null>(null);

  useEffect(() => {
    if (selected === null && galleries?.[0]) setSelected(galleries[0]._id);
  }, [galleries, selected]);

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
    <PageFrame
      actions={<Link className={layout.quietButton} to="/">Public view</Link>}
    >
      <div className={styles.adminLayout}>
        <aside className={styles.sidebar}>
          <h1>Administration</h1>
          <nav>
            {galleries.map((gallery) => (
              <button
                type="button"
                key={gallery._id}
                className={selected === gallery._id ? styles.selected : ""}
                onClick={() => setSelected(gallery._id)}
              >
                <span>{gallery.name}</span>
                <small>{gallery.kind}</small>
              </button>
            ))}
          </nav>
          {profile.isSystemAdmin ? <CreateGallery onCreated={setSelected} /> : null}
        </aside>
        <section className={styles.content}>
          {selected ? (
            <GalleryAdmin galleryId={selected} />
          ) : (
            <p>Create a gallery to get started.</p>
          )}
          {profile.isSystemAdmin ? <SystemUsers /> : null}
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
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const kind = form.get("kind") as GalleryKind;
    const slug = String(form.get("slug"));
    void create({
      name: String(form.get("name")),
      slug,
      kind,
      storageKind: form.get("storageKind") as StorageKind,
      storageRoot: String(form.get("storageRoot") || slug),
      hosts: [
        {
          host: String(form.get("host")),
          rootPath: String(form.get("rootPath") || "/"),
        },
      ],
    })
      .then((id) => {
        props.onCreated(id);
        setOpen(false);
      })
      .catch((reason: unknown) =>
        setError(friendlyError(reason, "Could not create")),
      );
  };
  return open ? (
    <form className={`${layout.form} ${styles.createForm}`} onSubmit={submit}>
      <h2>New gallery</h2>
      <label>Name<input name="name" required /></label>
      <label>Slug<input name="slug" required placeholder="family-photos" /></label>
      <label>Kind<select name="kind"><option value="image">Image gallery</option><option value="uploader">Uploader</option></select></label>
      <label>Storage<select name="storageKind"><option value="shared">Shared</option><option value="user">User mount</option></select></label>
      <label>Storage root<input name="storageRoot" required placeholder="gallery-name" /></label>
      <label>Domain<input name="host" required placeholder="photos.example.com" /></label>
      <label>URL root<input name="rootPath" defaultValue="/" /></label>
      {error ? <p className={layout.formError}>{error}</p> : null}
      <div className={layout.buttonRow}><button type="submit">Create</button><button type="button" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  ) : (
    <button type="button" className={styles.newButton} onClick={() => setOpen(true)}>＋ New gallery</button>
  );
}

function GalleryAdmin(props: { galleryId: Id<"galleries"> }) {
  const details = useQuery(api.galleries.adminDetails, {
    galleryId: props.galleryId,
  });
  const update = useMutation(api.galleries.update);
  const remove = useMutation(api.galleries.remove);
  const upsertRole = useMutation(api.roles.upsert);
  const revokeRole = useMutation(api.roles.revoke);
  const requestMigration = useMutation(api.migrations.request);
  const [message, setMessage] = useState<string | null>(null);
  if (details === undefined) return <p>Loading gallery…</p>;
  const gallery = details.gallery;

  const updateSettings = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const hosts = String(data.get("hosts"))
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [host, rootPath = "/"] = line.split("|");
        return { host: host.trim(), rootPath: rootPath.trim() };
      });
    void update({
      galleryId: gallery._id,
      name: String(data.get("name")),
      maxFileSize: Number(data.get("maxFileSize")),
      uploaderAccess: data.get("uploaderAccess") as
        | "anonymous"
        | "sso"
        | "restricted",
      hosts,
      theme: {
        accent: String(data.get("accent") || "") || undefined,
        background: String(data.get("background") || "") || undefined,
        foreground: String(data.get("foreground") || "") || undefined,
        surface: String(data.get("surface") || "") || undefined,
        muted: String(data.get("muted") || "") || undefined,
        radius: Number(data.get("radius") || 4),
        density: data.get("density") as "compact" | "comfortable",
        customCss: String(data.get("customCss") || "") || undefined,
      },
    })
      .then(() => setMessage("Settings saved"))
      .catch(showError(setMessage));
  };

  return (
    <>
      <div className={styles.galleryHeading}>
        <div>
          <span className={styles.eyebrow}>{gallery.kind}</span>
          <h2>{gallery.name}</h2>
        </div>
        <Link to={`/${gallery.kind === "image" ? "g" : "up"}/${gallery.slug}`}>Open ↗</Link>
      </div>
      <div className={styles.stats}>
        <Stat label="Items" value={gallery.itemCount.toLocaleString()} />
        <Stat label="Storage" value={formatBytes(gallery.totalBytes)} />
        <Stat label="Backend" value={`${gallery.storageKind}/${gallery.storageRoot}`} />
      </div>
      {message ? <p className={message.startsWith("Error") ? layout.errorNotice : layout.notice}>{message}</p> : null}

      <Section title="Settings">
        <form className={`${layout.form} ${styles.twoColumns}`} onSubmit={updateSettings}>
          <label>Name<input name="name" defaultValue={gallery.name} /></label>
          <label>Maximum bytes<input name="maxFileSize" type="number" defaultValue={gallery.maxFileSize} /></label>
          <label>Uploader access<select name="uploaderAccess" defaultValue={gallery.uploaderAccess}><option value="anonymous">Anonymous</option><option value="sso">Any Google SSO user</option><option value="restricted">Granted users only</option></select></label>
          <label>Density<select name="density" defaultValue={gallery.theme.density ?? "compact"}><option value="compact">Compact</option><option value="comfortable">Comfortable</option></select></label>
          <label>Accent<input name="accent" type="color" defaultValue={gallery.theme.accent ?? "#126b5a"} /></label>
          <label>Background<input name="background" type="color" defaultValue={gallery.theme.background ?? "#f6f7f4"} /></label>
          <label>Foreground<input name="foreground" type="color" defaultValue={gallery.theme.foreground ?? "#17201d"} /></label>
          <label>Surface<input name="surface" type="color" defaultValue={gallery.theme.surface ?? "#ffffff"} /></label>
          <label>Muted<input name="muted" type="color" defaultValue={gallery.theme.muted ?? "#65716c"} /></label>
          <label>Corner radius<input name="radius" type="number" min="0" max="40" defaultValue={gallery.theme.radius ?? 4} /></label>
          <label className={styles.spanTwo}>Host routes <small>(one per line: host|/root)</small><textarea name="hosts" rows={3} defaultValue={details.hosts.map((host) => `${host.host}|${host.rootPath}`).join("\n")} /></label>
          <label className={styles.spanTwo}>Scoped custom CSS<textarea name="customCss" rows={5} defaultValue={gallery.theme.customCss ?? ""} /></label>
          <button type="submit">Save settings</button>
        </form>
      </Section>

      <FileIconAdmin galleryId={gallery._id} setMessage={setMessage} />

      <Section title="Permissions">
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
          <input name="email" type="email" placeholder="Existing SSO user email" required />
          <select name="role"><option value="viewer">Viewer</option><option value="editor">Editor</option><option value="owner">Owner</option></select>
          <input name="folderId" placeholder="Folder ID (blank = whole gallery)" />
          <button type="submit">Grant</button>
        </form>
        <div className={styles.rows}>
          {details.grants.map((grant) => (
            <div className={styles.row} key={grant._id}>
              <span>{grant.profile?.email ?? grant.profile?.displayName ?? "Unknown user"}</span>
              <span>{grant.role}{grant.folderId ? " · folder scope" : " · gallery scope"}</span>
              <button type="button" onClick={() => void revokeRole({ grantId: grant._id }).catch(showError(setMessage))}>Revoke</button>
            </div>
          ))}
        </div>
      </Section>

      {gallery.kind === "image" ? (
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

function SystemUsers() {
  const users = useQuery(api.profiles.listForAdmin);
  const setAdmin = useMutation(api.profiles.setSystemAdmin);
  if (users === undefined) return null;
  return (
    <Section title="System users">
      <div className={styles.rows}>
        {users.filter((user) => !user.isAnonymous && !user.mergedIntoProfileId).map((user) => (
          <div className={styles.row} key={user._id}>
            <span>{user.email ?? user.displayName}</span>
            <span>{user.isSystemAdmin ? "Administrator" : "User"}</span>
            <button type="button" onClick={() => void setAdmin({ profileId: user._id, enabled: !user.isSystemAdmin })}>{user.isSystemAdmin ? "Remove admin" : "Make admin"}</button>
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

function showError(setter: (value: string) => void) {
  return (reason: unknown) =>
    setter(`Error: ${friendlyError(reason)}`);
}
