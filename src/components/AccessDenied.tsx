import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { anonymousClaim, authClient } from "../lib/authClient";
import { PageFrame } from "./PageFrame";

/**
 * Replaces a gallery or folder the current viewer may not see. The server
 * decides access; this page explains the refusal and offers the one action
 * that can change it. Logging in re-runs the queries, so an allowed account
 * lands in the gallery without another navigation.
 */
export function AccessDenied(props: {
  gallery?: Doc<"galleries">;
  scope: "gallery" | "folder";
}) {
  const profile = useQuery(api.profiles.current, {
    anonymousClaim: anonymousClaim(),
  });
  const { signIn } = authClient.useGoogleAuth();
  const signedIn =
    profile !== undefined && profile !== null && !profile.isAnonymous;
  const subject = props.scope === "gallery" ? "this gallery" : "this folder";
  return (
    <PageFrame gallery={props.gallery}>
      <section style={{ maxWidth: 560, margin: "12vh auto" }}>
        <h1>Access restricted</h1>
        {signedIn ? (
          <p>Your account does not have access to {subject}.</p>
        ) : (
          <>
            <p>Viewing {subject} requires an account that has been given access.</p>
            <button type="button" onClick={() => signIn()}>
              Log in
            </button>
          </>
        )}
      </section>
    </PageFrame>
  );
}
