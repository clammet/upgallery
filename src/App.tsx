import { useEffect, useRef } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { Link, Route, Routes, useLocation, useParams } from "react-router-dom";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { getOrCreateAnonymousClaim } from "./lib/anonymousClaim";
import { uploaderFileEntryId } from "./lib/uploaderRoutes";
import { GalleryPage } from "./pages/GalleryPage";
import { UploaderFilePage } from "./pages/UploaderFilePage";
import { UploaderPage } from "./pages/UploaderPage";
import { AdminPage } from "./pages/AdminPage";
import { PageFrame } from "./components/PageFrame";
import { AuthCallbackPage } from "./components/AuthCallbackPage";
import { clearAnonymousClaim } from "./lib/anonymousClaim";

export function App() {
  return (
    <>
      <AuthBootstrap />
      <Routes>
        <Route path="/auth/callback" element={<AuthCallbackPage />} />
        <Route path="/admin/*" element={<AdminPage />} />
        <Route path="/g/:slug" element={<SlugGallery expectedKind="image" />} />
        <Route
          path="/up/:slug/files/:entryId/:fileName?"
          element={<SlugUploaderFile />}
        />
        <Route path="/up/:slug" element={<SlugGallery expectedKind="uploader" />} />
        <Route path="*" element={<HostGallery />} />
      </Routes>
    </>
  );
}

function AuthBootstrap() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const ensureProfile = useMutation(api.profiles.ensureCurrent);
  const syncing = useRef<string | null>(null);

  useEffect(() => {
    if (isLoading) return;
    const anonymousClaim = getOrCreateAnonymousClaim();
    const key = `${isAuthenticated ? "google" : "anonymous"}:${anonymousClaim}`;
    if (syncing.current === key) return;
    syncing.current = key;
    void ensureProfile({ anonymousClaim })
      .then(() => {
        if (isAuthenticated) clearAnonymousClaim();
      })
      .catch((error: unknown) => {
        console.error("Failed to synchronize authentication profile", error);
        syncing.current = null;
      });
  }, [ensureProfile, isAuthenticated, isLoading]);
  return null;
}

function SlugGallery(props: { expectedKind: "image" | "uploader" }) {
  const { slug = "" } = useParams();
  const resolved = useQuery(api.galleries.resolveBySlug, {
    slug,
    anonymousClaim: getOrCreateAnonymousClaim(),
  });
  if (resolved === undefined) return <Loading />;
  if (
    resolved === null ||
    resolved.rootFolder === null ||
    resolved.gallery.kind !== props.expectedKind
  ) {
    return <NotFound />;
  }
  return resolved.gallery.kind === "image" ? (
    <GalleryPage gallery={resolved.gallery} rootFolder={resolved.rootFolder} />
  ) : (
    <UploaderPage
      gallery={resolved.gallery}
      rootFolder={resolved.rootFolder}
      routeRoot={`/up/${resolved.gallery.slug}`}
    />
  );
}

function SlugUploaderFile() {
  const { slug = "", entryId = "" } = useParams();
  const resolved = useQuery(api.galleries.resolveBySlug, {
    slug,
    anonymousClaim: getOrCreateAnonymousClaim(),
  });
  if (resolved === undefined) return <Loading />;
  if (
    resolved === null ||
    resolved.rootFolder === null ||
    resolved.gallery.kind !== "uploader"
  ) {
    return <NotFound />;
  }
  return (
    <UploaderFilePage
      gallery={resolved.gallery}
      entryId={entryId as Id<"entries">}
    />
  );
}

function HostGallery() {
  const location = useLocation();
  const resolved = useQuery(api.galleries.resolveByHost, {
    anonymousClaim: getOrCreateAnonymousClaim(),
    host: window.location.host,
    path: location.pathname,
  });
  if (resolved === undefined) return <Loading />;
  if (resolved === null || resolved.rootFolder === null) {
    return <Landing />;
  }
  const servedEntryId =
    resolved.gallery.kind === "uploader"
      ? uploaderFileEntryId(location.pathname, resolved.routeRoot)
      : null;
  if (servedEntryId !== null) {
    return (
      <UploaderFilePage
        gallery={resolved.gallery}
        entryId={servedEntryId as Id<"entries">}
      />
    );
  }
  return resolved.gallery.kind === "image" ? (
    <GalleryPage gallery={resolved.gallery} rootFolder={resolved.rootFolder} />
  ) : (
    <UploaderPage
      gallery={resolved.gallery}
      rootFolder={resolved.rootFolder}
      routeRoot={resolved.routeRoot}
    />
  );
}

function Loading() {
  return <PageFrame><p>Loading…</p></PageFrame>;
}

function NotFound() {
  return <PageFrame><h1>Not found</h1><p>This gallery does not exist.</p></PageFrame>;
}

function Landing() {
  const profile = useQuery(api.profiles.current, {
    anonymousClaim: getOrCreateAnonymousClaim(),
  });
  return (
    <PageFrame>
      <section style={{ maxWidth: 560, margin: "12vh auto" }}>
        <p style={{ color: "var(--muted)" }}>Multi-gallery file hosting</p>
        <h1 style={{ fontSize: "clamp(2rem, 8vw, 4.5rem)", margin: "0 0 1rem" }}>upgallery</h1>
        <p>There is no gallery configured for this host and path.</p>
        {profile?.isSystemAdmin ? <Link to="/admin">Open administration</Link> : null}
      </section>
    </PageFrame>
  );
}
