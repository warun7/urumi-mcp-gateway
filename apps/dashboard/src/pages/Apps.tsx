import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, errorText } from '../api';
import { useUser } from '../auth';
import { Avatar, Badge, Button, Card, CopyField, Empty, ErrorBox, PageHead, Segmented, SkeletonRows, Status, Time, useConfirm, useToast } from '../components/ui';
import { Icons } from '../icons';
import type { Grant } from '../types';

const MODE_LABEL: Record<Grant['toolMode'], string> = { auto: 'Auto', full: 'All tools', search: 'Search' };

export function AppsPage() {
  const { me, isAdmin } = useUser();
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const [all, setAll] = useState(false);
  const grants = useQuery({ queryKey: ['grants', all], queryFn: () => api<{ grants: Grant[] }>(`/oauth/grants${all ? '?all=1' : ''}`) });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/oauth/grants/${id}`, { method: 'DELETE' }),
    onSuccess: () => toast('Disconnected: the app’s tokens stopped working'),
    onError: (e) => toast(errorText(e), true),
    onSettled: () => qc.invalidateQueries({ queryKey: ['grants'] }),
  });
  const askRevoke = async (g: Grant) => {
    if (await confirm({ title: `Disconnect ${g.clientName}?`, body: 'Its access and refresh tokens stop working right away. To use it again, connect it again from the app.', confirmLabel: 'Disconnect', danger: true })) revoke.mutate(g.id);
  };

  const list = grants.data?.grants ?? [];
  return (
    <div className="page">
      <PageHead
        title="Connected apps"
        desc="MCP clients that signed in with OAuth. Each acts as the person who connected it, with their permissions. Disconnecting revokes its tokens immediately."
      />
      <Card pad={false}>
        {isAdmin && (
          <div className="toolbar">
            <Segmented size="sm" value={all ? 'all' : 'mine'} onChange={(v) => setAll(v === 'all')} options={[{ value: 'mine', label: 'Mine' }, { value: 'all', label: 'Whole team' }]} />
            {grants.data && <span className="count">{list.filter((g) => !g.revokedAt).length} connected</span>}
          </div>
        )}
        {grants.isPending ? <SkeletonRows rows={3} /> : grants.error ? <div className="card-body"><ErrorBox error={grants.error} /></div> : list.length === 0 ? (
          <Empty icon={<Icons.apps />} title="No connected apps yet">
            Add your gateway URL to an OAuth-capable client like Claude Code, Cursor or VS Code and sign in. It will appear here.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>App</th>{all && <th>Person</th>}<th>Tool mode</th><th>Connected</th><th>Last used</th><th>Status</th><th /></tr></thead>
              <tbody>
                {list.map((g) => (
                  <tr key={g.id} className={g.revokedAt ? 'dim' : undefined}>
                    <td>
                      <div className="person">
                        <Avatar name={g.clientName} />
                        <div className="truncate">
                          <div className="cell-title">{g.clientName}</div>
                          <div className="cell-sub">{g.verified ? <span className="ok-text">Verified · {g.host}</span> : 'Self-registered client'}</div>
                        </div>
                      </div>
                    </td>
                    {all && <td className="small">{g.user}</td>}
                    <td><Badge>{MODE_LABEL[g.toolMode] ?? g.toolMode}</Badge></td>
                    <td className="small muted"><Time iso={g.createdAt} /></td>
                    <td className="small muted">{g.lastUsedAt ? <Time iso={g.lastUsedAt} /> : 'Never'}</td>
                    <td>{g.revokedAt ? <Status>Disconnected</Status> : <Status tone="ok">Connected</Status>}</td>
                    <td className="actions-cell">{!g.revokedAt && <Button size="sm" variant="ghost" className="danger" onClick={() => void askRevoke(g)}>Disconnect</Button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="card-foot">
          <span className="nowrap">Your MCP URL</span>
          <div className="spacer"><CopyField value={me.mcpUrl} /></div>
        </div>
      </Card>
    </div>
  );
}
