import { CONNECTOR_CATALOG } from './connectorCatalog.js';

export interface VerifiedConnector {
  scopes: string[];
  meta: { label?: string; accountId?: string; username?: string; projectCount?: number; livemode?: boolean };
}

const manualProviders = new Set(CONNECTOR_CATALOG.map((entry) => entry.id).filter((id) => id !== 'github'));

export function isManualConnector(provider: string) {
  return manualProviders.has(provider);
}

async function providerRequest(url: string, token: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(12_000),
    headers: { Accept: 'application/json', ...(init.headers ?? {}) },
  });
  const body = await response.text();
  let json: any = null;
  try { json = body ? JSON.parse(body) : null; } catch { /* provider returned non-JSON */ }
  if (!response.ok) {
    const detail = typeof json?.message === 'string' ? json.message : `provider returned ${response.status}`;
    throw new Error(`Credential validation failed: ${detail}`);
  }
  return json;
}

export async function verifyConnectorToken(provider: string, token: string): Promise<VerifiedConnector> {
  if (!isManualConnector(provider)) throw new Error(`Connector ${provider} requires OAuth or is unsupported`);
  const value = token.trim();
  if (value.length < 8 || value.length > 4096) throw new Error('Credential must be between 8 and 4096 characters');

  switch (provider) {
    case 'neon': {
      const data = await providerRequest('https://console.neon.tech/api/v2/projects?limit=1', value, {
        headers: { Authorization: `Bearer ${value}` },
      });
      return { scopes: ['branches', 'read schema', 'execute SQL'], meta: { label: data?.projects?.[0]?.name ?? 'Neon account', projectCount: Array.isArray(data?.projects) ? data.projects.length : undefined } };
    }
    case 'supabase': {
      const data = await providerRequest('https://api.supabase.com/v1/projects', value, {
        headers: { Authorization: `Bearer ${value}` },
      });
      return { scopes: ['read schema', 'execute SQL'], meta: { label: 'Supabase account', projectCount: Array.isArray(data) ? data.length : undefined } };
    }
    case 'vercel': {
      const data = await providerRequest('https://api.vercel.com/v2/user', value, {
        headers: { Authorization: `Bearer ${value}` },
      });
      return { scopes: ['deployments'], meta: { label: data?.user?.username ?? data?.user?.name ?? 'Vercel account', accountId: data?.user?.id } };
    }
    case 'fly': {
      const data = await providerRequest('https://api.machines.dev/v1/apps', value, {
        headers: { Authorization: `Bearer ${value}` },
      });
      const apps = Array.isArray(data) ? data : data?.apps;
      return { scopes: ['machines'], meta: { label: 'Fly.io account', projectCount: Array.isArray(apps) ? apps.length : undefined } };
    }
    case 'stripe': {
      if (!value.startsWith('sk_test_')) throw new Error('Only Stripe test-mode secret keys are allowed');
      const data = await providerRequest('https://api.stripe.com/v1/account', value, {
        headers: { Authorization: `Basic ${Buffer.from(`${value}:`).toString('base64')}` },
      });
      if (data?.livemode === true) throw new Error('Only Stripe test-mode accounts are allowed');
      return { scopes: ['test keys only'], meta: { label: data?.business_profile?.name ?? data?.settings?.dashboard?.display_name ?? 'Stripe test account', accountId: data?.id, livemode: false } };
    }
    default:
      throw new Error(`Unknown connector: ${provider}`);
  }
}
