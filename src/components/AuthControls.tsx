import { useEffect, useRef, useState, type FormEvent } from "react";
import { useMutation, useQuery } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { Check, CircleUser, Pencil, X } from "lucide-react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { anonymousClaim, authClient } from "../lib/authClient";
import { friendlyError } from "../lib/errors";
import styles from "../styles/layout.module.css";

type Profile = NonNullable<FunctionReturnType<typeof api.profiles.current>>;

export function AuthControls(props: { gallery?: Doc<"galleries"> }) {
  const profile = useQuery(api.profiles.current, {
    anonymousClaim: anonymousClaim(),
  });
  const { signIn, signOut } = authClient.useGoogleAuth();
  const [open, setOpen] = useState(false);
  const group = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!group.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (profile === undefined) {
    return <span className={styles.authStatus}>…</span>;
  }
  if (profile === null || profile.isAnonymous) {
    return (
      <button
        className={styles.quietButton}
        type="button"
        onClick={() => signIn()}
      >
        Log in
      </button>
    );
  }
  return (
    <div className={styles.authGroup} ref={group}>
      <button
        className={styles.authName}
        type="button"
        title={profile.email}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <CircleUser aria-hidden="true" size={16} />
        <span className={styles.authNameText}>
          {profile.displayName ?? profile.email}
        </span>
      </button>
      {open ? (
        <AccountPopover profile={profile} gallery={props.gallery} />
      ) : null}
      <button
        className={styles.quietButton}
        type="button"
        onClick={() => {
          authClient.clearAnonymousClaim();
          signOut();
        }}
      >
        Log out
      </button>
    </div>
  );
}

function AccountPopover(props: {
  profile: Profile;
  gallery?: Doc<"galleries">;
}) {
  const updatePreferences = useMutation(api.profiles.updatePreferences);
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const galleryAllowsInfiniteScroll = props.gallery?.infiniteScroll !== false;

  useEffect(() => {
    if (editingName) nameInput.current?.select();
  }, [editingName]);

  const startEditing = () => {
    setDraftName(props.profile.displayName ?? "");
    setError(null);
    setEditingName(true);
  };

  const submitName = async (event: FormEvent) => {
    event.preventDefault();
    const displayName = draftName.trim();
    if (displayName === (props.profile.displayName ?? "")) {
      setEditingName(false);
      return;
    }
    setSaving(true);
    try {
      await updatePreferences({
        anonymousClaim: anonymousClaim(),
        displayName,
      });
      setEditingName(false);
      setError(null);
    } catch (cause) {
      setError(friendlyError(cause));
    } finally {
      setSaving(false);
    }
  };

  const togglePreference = async (
    preference: "infiniteScroll" | "overzoom",
    enabled: boolean,
  ) => {
    setError(null);
    try {
      await updatePreferences({
        anonymousClaim: anonymousClaim(),
        [preference]: enabled,
      });
    } catch (cause) {
      setError(friendlyError(cause));
    }
  };

  return (
    <div
      className={styles.accountPopover}
      role="dialog"
      aria-label="Account"
    >
      <div className={styles.accountIdentity}>
        {editingName ? (
          <form className={styles.accountNameForm} onSubmit={submitName}>
            <input
              ref={nameInput}
              aria-label="Display name"
              value={draftName}
              maxLength={80}
              disabled={saving}
              onChange={(event) => setDraftName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  setEditingName(false);
                }
              }}
            />
            <button
              type="submit"
              className={styles.iconButton}
              aria-label="Save display name"
              disabled={saving || draftName.trim().length === 0}
            >
              <Check aria-hidden="true" size={16} />
            </button>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Cancel"
              disabled={saving}
              onClick={() => setEditingName(false)}
            >
              <X aria-hidden="true" size={16} />
            </button>
          </form>
        ) : (
          <div className={styles.accountNameRow}>
            <strong className={styles.accountName}>
              {props.profile.displayName ?? props.profile.email}
            </strong>
            <button
              type="button"
              className={styles.iconButton}
              aria-label="Edit display name"
              onClick={startEditing}
            >
              <Pencil aria-hidden="true" size={15} />
            </button>
          </div>
        )}
        {props.profile.email ? (
          <small className={styles.accountEmail}>{props.profile.email}</small>
        ) : null}
      </div>
      <label
        className={styles.accountSetting}
        data-disabled={galleryAllowsInfiniteScroll ? undefined : "true"}
      >
        <span>
          Infinite scroll
          {galleryAllowsInfiniteScroll ? null : (
            <small className={styles.accountHint}>
              Turned off for this gallery
            </small>
          )}
        </span>
        <input
          type="checkbox"
          role="switch"
          className={styles.switch}
          checked={props.profile.infiniteScroll}
          disabled={!galleryAllowsInfiniteScroll}
          onChange={(event) =>
            void togglePreference("infiniteScroll", event.target.checked)
          }
        />
      </label>
      <label className={styles.accountSetting}>
        <span>
          Lightbox overzoom
          <small className={styles.accountHint}>
            Zoom images past their natural size
          </small>
        </span>
        <input
          type="checkbox"
          role="switch"
          className={styles.switch}
          checked={props.profile.overzoom}
          onChange={(event) =>
            void togglePreference("overzoom", event.target.checked)
          }
        />
      </label>
      {error ? <p className={styles.formError}>{error}</p> : null}
    </div>
  );
}
