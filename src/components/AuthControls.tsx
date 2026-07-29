import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import {
  clearAnonymousClaim,
  getOrCreateAnonymousClaim,
} from "../lib/anonymousClaim";
import { useGoogleAuth } from "../lib/googleAuth";
import styles from "../styles/layout.module.css";

export function AuthControls() {
  const profile = useQuery(api.profiles.current, {
    anonymousClaim: getOrCreateAnonymousClaim(),
  });
  const { signIn, signOut } = useGoogleAuth();

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
    <div className={styles.authGroup}>
      {profile.image ? (
        <img className={styles.avatar} src={profile.image} alt="" />
      ) : null}
      <span className={styles.authName}>{profile.displayName ?? profile.email}</span>
      <button
        className={styles.quietButton}
        type="button"
        onClick={() => {
          clearAnonymousClaim();
          signOut();
        }}
      >
        Log out
      </button>
    </div>
  );
}
