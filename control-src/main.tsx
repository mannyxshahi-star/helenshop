import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./theme.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, retryDelay: 1500 } },
});
const rootEl = document.querySelector<HTMLElement>("[data-generated-space-root]");
if (!rootEl) throw new Error("missing generated space root element");
createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <div className="hatch-space-root" data-generated-space-root="">
        <App />
      </div>
    </QueryClientProvider>
  </StrictMode>,
);
