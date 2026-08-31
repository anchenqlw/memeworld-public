import { api, ApiError } from './client';

type BootstrapApi = Pick<typeof api,
  'me' | 'patStatus' | 'getCat' | 'travels' | 'badges' | 'worldMap' | 'worldDigest' | 'proposals' | 'worldChronicle'
>;

export type BootstrapResult = {
  me: Awaited<ReturnType<BootstrapApi['me']>>;
  pat: PromiseSettledResult<Awaited<ReturnType<BootstrapApi['patStatus']>>>;
  cat: Awaited<ReturnType<BootstrapApi['getCat']>> | null;
  extras: {
    travels: PromiseSettledResult<Awaited<ReturnType<BootstrapApi['travels']>>>;
    badges: PromiseSettledResult<Awaited<ReturnType<BootstrapApi['badges']>>>;
    map: PromiseSettledResult<Awaited<ReturnType<BootstrapApi['worldMap']>>>;
    digest: PromiseSettledResult<Awaited<ReturnType<BootstrapApi['worldDigest']>>>;
    proposals: PromiseSettledResult<Awaited<ReturnType<BootstrapApi['proposals']>>>;
    chronicle: PromiseSettledResult<Awaited<ReturnType<BootstrapApi['worldChronicle']>>>;
  } | null;
};

export async function loadBootstrap(client: BootstrapApi = api): Promise<BootstrapResult> {
  const me = await client.me();
  const patPromise = client.patStatus().then(
    (value) => ({ status: 'fulfilled', value }) as const,
    (reason) => ({ status: 'rejected', reason }) as const,
  );
  let cat: Awaited<ReturnType<BootstrapApi['getCat']>> | null;
  try {
    cat = await client.getCat();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) cat = null;
    else throw error;
  }

  const pat = await patPromise;
  if (!cat) return { me, pat, cat, extras: null };

  const [travels, badges, map, digest, proposals, chronicle] = await Promise.allSettled([
    client.travels(), client.badges(), client.worldMap(), client.worldDigest(), client.proposals(), client.worldChronicle(),
  ]);
  return { me, pat, cat, extras: { travels, badges, map, digest, proposals, chronicle } };
}
