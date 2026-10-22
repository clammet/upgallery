import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useConvexAuth, useMutation, useQuery } from "convex/react";
import { Link, Route, Routes, useLocation, useParams } from "react-router-dom";
import { api } from "../convex/_generated/api";
import { anonymousClaim, authClient } from "./lib/authClient";
import { matchingGalleryRoot, publicGalleryRoute } from "./lib/galleryRoutes";
import { GalleryPage } from "./pages/GalleryPage";
import { PageFrame } from "./components/PageFrame";
import { AuthCallbackPage } from "./components/AuthCallbackPage";
import { AccessDenied } from "./components/AccessDenied";
import { GalleryErrorScope } from "./components/GalleryErrorBoundary";
import { useGalleryTheme } from "./hooks/useGalleryTheme";

const AdminPage = lazy(() =>
  import("./pages/AdminPage").then((module) => ({ default: module.AdminPage })),
);
const UploaderPage = lazy(() =>
  import("./pages/UploaderPage").then((module) => ({ default: module.UploaderPage })),
);

export function App() {
  return (
    <>
      <AuthBootstrap />
      <GalleryErrorScope>
        <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route path="/admin/*" element={
            <Suspense fallback={<PageFrame><p>Loading administration…</p></PageFrame>}>
              <AdminPage />
            </Suspense>
          } />
          <Route path="/g/:slug/*" element={<SlugGallery expectedKind="image" />} />
          <Route path="/up/:slug" element={<SlugGallery expectedKind="uploader" />} />
          <Route path="*" element={<HostGallery />} />
        </Routes>
        </Suspense>
      </GalleryErrorScope>
    </>
  );
}

function AuthBootstrap() {
  const { isAuthenticated, isLoading } = useConvexAuth();
  const ensureProfile = useMutation(api.profiles.ensureCurrent);
  const syncing = useRef<string | null>(null);

  useEffect(() => {
    if (isLoading || !isAuthenticated) return;
    const claim = anonymousClaim();
    const key = `google:${claim}`;
    if (syncing.current === key) return;
    syncing.current = key;
    void ensureProfile({ anonymousClaim: claim })
      .then(() => authClient.clearAnonymousClaim())
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
    anonymousClaim: anonymousClaim(),
  });
  const canonicalHostRoute = useQuery(api.galleries.canonicalRouteBySlug, {
    slug,
    currentHost: window.location.host,
  });
  useGalleryTheme(
    resolved?.rootFolder && resolved.gallery.kind === props.expectedKind
      ? resolved.gallery
      : undefined,
    `/${props.expectedKind === "image" ? "g" : "up"}/${slug}`,
  );
  if (resolved === undefined || canonicalHostRoute === undefined) {
    return <Loading />;
  }
  if (
    resolved === null ||
    resolved.rootFolder === null ||
    resolved.gallery.kind !== props.expectedKind
  ) {
    return <NotFound />;
  }
  if (!resolved.access.canView) {
    return <AccessDenied gallery={resolved.gallery} scope="gallery" />;
  }
  const canonicalRoute =
    canonicalHostRoute === null
      ? null
      : publicGalleryRoute(canonicalHostRoute, {
          protocol: window.location.protocol,
          host: window.location.host,
        });
  return (
    <GalleryErrorScope gallery={resolved.gallery}>
      {resolved.gallery.kind === "image" ? (
        <GalleryPage
          key={resolved.gallery._id}
          gallery={resolved.gallery}
          rootFolder={resolved.rootFolder}
          routeRoot={`/g/${resolved.gallery.slug}`}
          canonicalOrigin={canonicalRoute?.origin}
          canonicalRouteRoot={canonicalRoute?.routeRoot}
        />
      ) : (
        <UploaderPage
          key={resolved.gallery._id}
          gallery={resolved.gallery}
          rootFolder={resolved.rootFolder}
          routeRoot={`/up/${resolved.gallery.slug}`}
          canonicalOrigin={canonicalRoute?.origin}
          canonicalRouteRoot={canonicalRoute?.routeRoot}
        />
      )}
    </GalleryErrorScope>
  );
}

function HostGallery() {
  const location = useLocation();
  // Keep the original query subscribed while navigating inside its gallery.
  // The server also returns route boundaries, so a nested gallery or a live
  // routing change still causes a new authoritative resolution.
  const [resolutionPath, setResolutionPath] = useState(location.pathname);
  const resolved = useQuery(api.galleries.resolveByHost, {
    anonymousClaim: anonymousClaim(),
    host: window.location.host,
    path: resolutionPath,
  });
  const changingGallery = location.pathname !== resolutionPath &&
    (resolved === null || (resolved !== undefined &&
      matchingGalleryRoot(location.pathname, resolved.hostRouteRoots) !== resolved.routeRoot));
  useGalleryTheme(
    !changingGallery && resolved?.rootFolder ? resolved.gallery : undefined,
    resolved?.routeRoot,
  );
  if (changingGallery) {
    setResolutionPath(location.pathname);
    return <Loading />;
  }
  if (resolved === undefined) return <Loading />;
  if (resolved === null || resolved.rootFolder === null) {
    return <Landing />;
  }
  if (!resolved.access.canView) {
    return <AccessDenied gallery={resolved.gallery} scope="gallery" />;
  }
  return (
    <GalleryErrorScope gallery={resolved.gallery}>
      {resolved.gallery.kind === "image" ? (
        <GalleryPage
          key={resolved.gallery._id}
          gallery={resolved.gallery}
          rootFolder={resolved.rootFolder}
          routeRoot={resolved.routeRoot}
        />
      ) : (
        <UploaderPage
          key={resolved.gallery._id}
          gallery={resolved.gallery}
          rootFolder={resolved.rootFolder}
          routeRoot={resolved.routeRoot}
        />
      )}
    </GalleryErrorScope>
  );
}

function Loading() {
  return <PageFrame loading><p>Loading…</p></PageFrame>;
}

function NotFound() {
  return <PageFrame><h1>Not found</h1><p>This gallery does not exist.</p></PageFrame>;
}

function Landing() {
  const profile = useQuery(api.profiles.current, {
    anonymousClaim: anonymousClaim(),
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
