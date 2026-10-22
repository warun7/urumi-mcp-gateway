import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { ApiError } from './api';
import { RequireAuth, RequireAdmin } from './auth';
import { ConfirmHost, ToastHost } from './components/ui';
import { Layout } from './Layout';
import { AccountPage } from './pages/Account';
import { AppsPage } from './pages/Apps';
import { AuditPage } from './pages/Audit';
import { ChatPage } from './pages/Chat';
import { ConsentPage } from './pages/Consent';
import { InvitePage } from './pages/Invite';
import { KeysPage } from './pages/Keys';
import { LoginPage } from './pages/Login';
import { MembersPage } from './pages/Members';
import { OverviewPage } from './pages/Overview';
import { PermissionsPage } from './pages/Permissions';
import { ServerDetailPage } from './pages/ServerDetail';
import { ServersPage } from './pages/Servers';
import { StoresPage } from './pages/Stores';
import './styles.css';
import { applyTheme, readTheme } from './theme';

// Before the first render, so a chosen theme doesn't flash the OS one.
applyTheme(readTheme());

// A 401 anywhere means the session ended (expired, logged out elsewhere, or the user was disabled).
const onAuthError = (err: unknown) => {
  if (err instanceof ApiError && err.status === 401 && !location.pathname.startsWith('/login')) {
    location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
  }
};
const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onAuthError }),
  mutationCache: new MutationCache({ onError: onAuthError }),
  defaultOptions: {
    queries: { retry: (n, err) => !(err instanceof ApiError && err.status < 500) && n < 2, refetchOnWindowFocus: true, staleTime: 5_000 },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastHost>
        <ConfirmHost>
          <BrowserRouter>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route path="/invite/:token" element={<InvitePage />} />
              <Route path="/consent" element={<RequireAuth><ConsentPage /></RequireAuth>} />
              <Route element={<RequireAuth><Layout /></RequireAuth>}>
                <Route index element={<OverviewPage />} />
                <Route path="servers" element={<ServersPage />} />
                <Route path="servers/:id" element={<ServerDetailPage />} />
                <Route path="chat" element={<ChatPage />} />
                <Route path="keys" element={<KeysPage />} />
                <Route path="apps" element={<AppsPage />} />
                <Route path="audit" element={<AuditPage />} />
                <Route path="account" element={<AccountPage />} />
                <Route path="stores" element={<StoresPage />} />
                <Route path="members" element={<RequireAdmin><MembersPage /></RequireAdmin>} />
                <Route path="permissions" element={<RequireAdmin><PermissionsPage /></RequireAdmin>} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Routes>
          </BrowserRouter>
        </ConfirmHost>
      </ToastHost>
    </QueryClientProvider>
  </StrictMode>,
);
