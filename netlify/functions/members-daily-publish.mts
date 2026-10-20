// Netlify scheduled function (07:00 IST daily): the "published automatically every day" half of risk-based
// publishing. It starts one site build if approved public stories are waiting, so low-risk stories reach
// tvc.farm without anyone pressing the button. Does nothing in shadow mode (the default) or while paused,
// and does nothing on days with nothing waiting, so it costs a build only when there is something to publish.
// See docs/plans/member-portal.md, "Risk-based publishing".
import { loadSettings, recordAutoPublish, waitingPublicStories } from './lib/story-risk';
import { actsAutomatically } from '../../scripts/lib/member-autopublish.mjs';

export default async (): Promise<Response> => {
  try {
    const settings = await loadSettings();
    if (!actsAutomatically(settings)) return new Response(JSON.stringify({ ok: true, skipped: settings.paused ? 'paused' : 'shadow mode' }), { status: 200 });
    const waiting = await waitingPublicStories();
    if (waiting === 0) return new Response(JSON.stringify({ ok: true, skipped: 'nothing waiting' }), { status: 200 });
    const hook = process.env.NETLIFY_BUILD_HOOK_URL;
    if (!hook) {
      console.error('[members-daily-publish] NETLIFY_BUILD_HOOK_URL is not set');
      return new Response('Not set up', { status: 500 });
    }
    const res = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    if (!res.ok) {
      console.error('[members-daily-publish] build hook failed', res.status);
      return new Response('Build not started', { status: 502 });
    }
    await recordAutoPublish(new Date().toISOString());
    console.log(`[members-daily-publish] build started for ${waiting} waiting stor${waiting === 1 ? 'y' : 'ies'}`);
    return new Response(JSON.stringify({ ok: true, waiting }), { status: 200 });
  } catch (err) {
    console.error('[members-daily-publish] failed', err);
    return new Response('Failed', { status: 500 });
  }
};

// 01:30 UTC = 07:00 in India.
export const config = { schedule: '30 1 * * *' };
