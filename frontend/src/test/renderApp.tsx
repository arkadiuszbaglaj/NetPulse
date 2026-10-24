import { QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { App } from "../App";
import { AuthProvider } from "../auth/AuthProvider";
import { createQueryClient } from "../lib/queryClient";
import { ThemeProvider } from "../lib/theme";

export function renderApp(path = "/") {
  window.history.pushState({}, "", path);
  const client = createQueryClient({ retry: false });
  const view = render(
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>,
  );
  return { ...view, client };
}
