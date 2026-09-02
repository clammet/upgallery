import { Component, type ReactNode } from "react";
import { useConvexAuth } from "convex/react";
import { useLocation } from "react-router-dom";
import type { Doc } from "../../convex/_generated/dataModel";
import { friendlyError, isUnauthorizedError } from "../lib/errors";
import { AccessDenied } from "./AccessDenied";
import { PageFrame } from "./PageFrame";

/**
 * Convex queries throw during render when the server rejects them. Without a
 * boundary React unmounts the whole tree and the viewer gets an empty page.
 * The boundary resets whenever the location or the login state changes, so
 * navigating away or logging in retries the queries instead of keeping a
 * stale failure on screen.
 */
export function GalleryErrorScope(props: {
  gallery?: Doc<"galleries">;
  children: ReactNode;
}) {
  const location = useLocation();
  const { isAuthenticated } = useConvexAuth();
  return (
    <GalleryErrorBoundary
      gallery={props.gallery}
      resetKey={`${location.pathname}${location.search}|${isAuthenticated}`}
    >
      {props.children}
    </GalleryErrorBoundary>
  );
}

type Props = {
  gallery?: Doc<"galleries">;
  resetKey: string;
  children: ReactNode;
};

type State = { error: unknown; failed: boolean; resetKey: string };

class GalleryErrorBoundary extends Component<Props, State> {
  state: State = { error: null, failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error, failed: true };
  }

  static getDerivedStateFromProps(
    props: Props,
    state: State,
  ): Partial<State> | null {
    if (props.resetKey === state.resetKey) return null;
    return { error: null, failed: false, resetKey: props.resetKey };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    if (isUnauthorizedError(this.state.error)) {
      return <AccessDenied gallery={this.props.gallery} scope="folder" />;
    }
    return (
      <PageFrame gallery={this.props.gallery}>
        <section style={{ maxWidth: 560, margin: "12vh auto" }}>
          <h1>Something went wrong</h1>
          <p>
            {friendlyError(this.state.error, "The gallery could not be loaded.")}
          </p>
          <button
            type="button"
            onClick={() => this.setState({ error: null, failed: false })}
          >
            Try again
          </button>
        </section>
      </PageFrame>
    );
  }
}
