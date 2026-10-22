import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { api, ApiError } from './api';
import { Callout, Loading } from './components/ui';
import type { Me } from './types';

export const useMe = () => useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/me'), staleTime: 60_000 });

/** Returns the signed-in user. Only call below <RequireAuth>. */
export function useUser() {
  const { data } = useMe();
  return { me: data!, isAdmin: data?.user.role === 'admin' };
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const me = useMe();
  const loc = useLocation();
  if (me.isPending) return <div className="auth-page"><Loading /></div>;
  if (me.error) {
    if (me.error instanceof ApiError && me.error.status === 401) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
    return (
      <div className="auth-page">
        <div className="auth-box">
          <Callout tone="err" title="Can't reach the gateway">{me.error.message}. It may be restarting; this page retries when you reload.</Callout>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

export function RequireAdmin({ children }: { children: ReactNode }) {
  const { isAdmin } = useUser();
  return isAdmin ? <>{children}</> : <Navigate to="/" replace />;
}
