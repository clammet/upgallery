import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import {
  GoogleAuthProvider,
  useConvexGoogleAuth,
} from "./lib/googleAuth";
import "./styles/tokens.css";
import "./styles/global.css";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <GoogleAuthProvider>
      <ConvexProviderWithAuth client={convex} useAuth={useConvexGoogleAuth}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ConvexProviderWithAuth>
    </GoogleAuthProvider>
  </StrictMode>,
);
