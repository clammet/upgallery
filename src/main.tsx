import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { authClient } from "./lib/authClient";
import { loadConfig } from "./config";
import "./styles/tokens.css";
import "./styles/global.css";

const root = createRoot(document.getElementById("root")!);

loadConfig()
  .then((cfg) => {
    const convex = new ConvexReactClient(cfg.CONVEX_URL);

    root.render(
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
  })
  .catch((err) => {
    console.error("Failed to start the app:", err);
    root.render(
      <StrictMode>
        <p style={{ textAlign: "center", marginTop: "4rem" }}>
          Couldn&rsquo;t load the app configuration.
        </p>
      </StrictMode>,
    );
  });
