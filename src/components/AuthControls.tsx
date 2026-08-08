import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { anonymousClaim, authClient } from "../lib/authClient";
import styles from "../styles/layout.module.css";

export function AuthControls() {
  const profile = useQuery(api.profiles.current, {
    anonymousClaim: anonymousClaim(),
  });
  const { signIn, signOut } = authClient.useGoogleAuth();

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
      <span className={styles.authName} title={profile.email}>
        {profile.displayName ?? profile.email}
      </span>
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
