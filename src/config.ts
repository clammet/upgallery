interface AppConfig {
  CONVEX_URL: string;
  CONVEX_SITE_URL: string;
  GOOGLE_CLIENT_ID: string;
}

let config: AppConfig | null = null;

export async function loadConfig(): Promise<AppConfig> {
  if (config) return config;

  try {
    const res = await fetch("/config.json");
    if (res.ok) {
      const json = await res.json();
      if (json.CONVEX_URL && json.CONVEX_SITE_URL && json.GOOGLE_CLIENT_ID) {
        config = json as AppConfig;
        return config;
      }
    }
  } catch {
    // No config.json available — fall through to env vars (dev mode)
  }

  config = {
    CONVEX_URL: import.meta.env.VITE_CONVEX_URL,
    CONVEX_SITE_URL: import.meta.env.VITE_CONVEX_SITE_URL,
    GOOGLE_CLIENT_ID: import.meta.env.VITE_GOOGLE_CLIENT_ID,
  };
  return config;
}

export function getConfig(): AppConfig {
  if (!config) throw new Error("Config not loaded — call loadConfig() first");
  return config;
}
