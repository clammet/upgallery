import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { authClient } from "./lib/authClient";
import "./styles/tokens.css";
import "./styles/global.css";

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <authClient.GoogleAuthProvider>
      <ConvexProviderWithAuth
        client={convex}
        useAuth={authClient.useConvexGooglyAuth}
      >
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ConvexProviderWithAuth>
    </authClient.GoogleAuthProvider>
  </StrictMode>,
);
